import { localTime } from "../../components/format";
import type { Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { isInstanceOperator } from "@/lib/auth/instance-operator";
import { getInstanceLicense, setLicense, clearLicense, licenseRejectionMessage, type LicenseState } from "@/lib/license/gate";
import { requireInstanceOperator } from "../../../middleware/instance-operator";
import { settingsAuth, settingsPage, managedByOperator, type Html } from "./shell";

function renderLicense(state: LicenseState, msg?: string, msgOk = false): Html {
  const notice = msg ? html`<div class="notice ${msgOk ? "notice-ok" : "notice-err"}">${msg}</div>` : html``;
  const sourceLabel = state.source === "db" ? "panel" : state.source === "env" ? "environment variable" : "—";
  // When the active license comes from the LICENSE_KEY env var (server config), make it explicit —
  // otherwise the panel looks "empty" (no stored token) even though PRO is active, which is confusing.
  const envNote = state.source === "env"
    ? html`<div class="notice notice-info">ℹ This license is provided by the <code>LICENSE_KEY</code> environment variable (server config), not the panel — so there's nothing to paste here. To change it, update the env var. Pasting a token below would override the env one via the panel.</div>`
    : html``;
  return html`${notice}${envNote}
    <div class="card" style="margin-bottom:1rem">
      <div><strong>Status:</strong> <span class="badge">${state.status}</span>${state.tier ? html` &nbsp;<strong>Tier:</strong> ${state.tier}` : html``}${state.expiresAt ? html` &nbsp;<span class="muted">expires ${localTime(new Date(state.expiresAt))}</span>` : html``}</div>
      ${state.products.size > 0 ? html`<div style="margin-top:.4rem"><strong>Products:</strong> ${[...state.products].map((p) => html`<span class="badge">${p}</span> `)}</div>` : html``}
      ${state.features.size > 0 ? html`<div class="muted" style="margin-top:.4rem">Unlocked: ${[...state.features].join(", ")}</div>` : html``}
      <div class="muted" style="margin-top:.4rem;font-size:.8rem">Source: ${sourceLabel}</div>
    </div>
    <div class="row">
      ${state.status !== "active" ? html`<a class="btn btn-primary" href="${state.upgradeUrl}" target="_blank" rel="noopener">Buy PRO</a>` : html``}
      ${state.source === "db" ? html`<button class="btn btn-sm" hx-post="/settings/license/clear" hx-target="#license-area" hx-swap="innerHTML" hx-confirm="Remove the stored license token?">Remove license</button>` : html``}
    </div>`;
}

export function registerLicenseSettings(app: Hono, guard: MiddlewareHandler): void {
  app.get("/settings/license", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.redirect("/login");
    const body = (await isInstanceOperator(a))
      ? html`<section class="section"><h2>License</h2>
          <p class="muted" style="margin-bottom:1rem">Unlock PRO features with a license token from Sellf. A free instance keeps all free features.</p>
          <form hx-post="/settings/license" hx-ext="json-enc" hx-target="#license-area" hx-swap="innerHTML" class="stack" style="margin-bottom:1rem">
            <textarea class="input mono" name="token" rows="3" placeholder="Paste your license token" style="font-size:.8rem"></textarea>
            <div class="row"><button class="btn btn-primary" type="submit">Verify &amp; save</button></div>
          </form>
          <div id="license-area">${renderLicense(await getInstanceLicense())}</div></section>`
      : html`<section class="section"><h2>License</h2>${managedByOperator}</section>`;
    return settingsPage(c, a, "/settings/license", body);
  });

  app.post("/settings/license", guard, requireInstanceOperator, async (c) => {
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof form.token === "string" ? form.token.trim() : "";
    if (!token) {
      return c.html(renderLicense(await getInstanceLicense(), "Paste a license token first."));
    }
    const result = await setLicense(token);
    if (!result.ok) {
      return c.html(renderLicense(result.state, licenseRejectionMessage(result.reason)));
    }
    return c.html(renderLicense(result.state, "License activated.", true));
  });

  app.post("/settings/license/clear", guard, requireInstanceOperator, async (c) => {
    return c.html(renderLicense(await clearLicense(), "License removed.", true));
  });
}
