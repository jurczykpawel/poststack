import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { BRAND } from "@/lib/brand";
import { authenticateSession } from "@/lib/auth";
import { getInstanceLicense, ProRequiredError } from "@/lib/license/gate";
import { readPick, listPickOptions, connectPicked, clearPickCookie, type PickOption } from "@/lib/oauth/pick";
import { ProviderError } from "@/lib/providers/errors";
import { renderPage } from "../layout";
import { platformLabel } from "../components/platform";

/** "Connect pages" picker: shown after the `?pages=1` OAuth variant (e.g. LinkedIn Company Pages). */
export function registerChannelPick(r: Hono, guard: MiddlewareHandler): void {
  r.get("/channels/pick/:platform", guard, (c) => pickPage(c));
  r.post("/channels/pick/:platform", guard, async (c) => {
    const ctx = await pickContext(c);
    if (!ctx) return c.redirect("/channels?error=invalid_state", 303);
    const form = await c.req.parseBody({ all: true });
    const values = ([] as unknown[]).concat(form.account ?? []).map(String);
    if (!values.length) return pickPage(c, "Tick at least one account to connect.");
    try {
      const count = await connectPicked(ctx.platform, ctx.tokens, ctx.auth, values);
      if (!count) return pickPage(c, "None of the selected accounts is available any more. Refresh and try again.");
      c.header("Set-Cookie", clearPickCookie());
      return c.redirect(`/channels?connected=${encodeURIComponent(ctx.platform)}&count=${count}`, 303);
    } catch (e) {
      if (e instanceof ProRequiredError) return c.redirect("/channels?error=pro_required", 303);
      if (e instanceof ProviderError) return pickPage(c, e.message);
      throw e;
    }
  });
}

async function pickContext(c: Context) {
  const auth = await authenticateSession(c.req.raw).catch(() => null);
  const platform = c.req.param("platform") ?? "";
  const tokens = auth && readPick(c.req.header("cookie") ?? null, platform, auth);
  return auth && tokens ? { auth, platform, tokens } : null;
}

async function pickPage(c: Context, notice?: string): Promise<Response> {
  const ctx = await pickContext(c);
  if (!ctx) return c.redirect("/channels?error=invalid_state", 303);
  const label = platformLabel(ctx.platform);
  let options: PickOption[] = [];
  let error = notice;
  try {
    options = await listPickOptions(ctx.platform, ctx.tokens);
  } catch (e) {
    if (!(e instanceof ProviderError)) console.error(`[channel-pick] ${ctx.platform} listing failed:`, e instanceof Error ? e.message : e);
    error = e instanceof ProviderError ? e.message : "Could not load your accounts from the provider. Try again.";
  }
  const pages = options.filter((o) => o.kind === "page");
  const lic = await getInstanceLicense();
  const row = (o: PickOption) => html`<label class="chk-inline pick-row"><input type="checkbox" name="account" value="${o.value}" ${o.kind === "page" ? "checked" : ""} />
    <span><b>${o.name}</b> <small class="muted">${o.kind === "person" ? "Your profile" : "Company Page"}</small></span></label>`;
  return c.html(renderPage({
    title: `Connect ${label}`,
    nav: "channels",
    features: lic.features,
    products: lic.products,
    breadcrumb: `Connect ${label}`,
    body: html`<section class="panel" style="max-width:40rem">
      <div class="panel-head"><h3>Where should ${BRAND.name} publish?</h3></div>
      <div style="padding:12px 14px">
      <p class="muted">Each ticked account becomes its own channel. You can connect more later.</p>
      ${error ? html`<div class="auth-error" role="alert">${error}</div>` : ""}
      ${options.length && !pages.length ? html`<p class="muted">No Company Pages found where you are a Super admin or Content admin.</p>` : ""}
      ${options.length ? html`<form method="post" class="ct-form" style="display:grid;gap:.6rem;margin-top:.8rem">
        ${options.map(row)}
        <div><button class="btn btn-primary btn-sm" type="submit">Connect selected</button> <a class="btn btn-ghost btn-sm" href="/channels">Cancel</a></div>
      </form>` : html`<p><a class="btn btn-ghost btn-sm" href="/channels">Back to channels</a></p>`}
      </div>
    </section>`,
  }));
}
