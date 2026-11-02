import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys as apiKeysTbl } from "@/db/schema";
import { BRAND } from "@/lib/brand";
import { getInstanceLicense } from "@/lib/license/gate";
import { API_SCOPE_DEFINITIONS, API_SCOPE_GROUPS, API_SCOPE_PRESETS, API_SCOPES } from "@/lib/auth/scopes";
import * as apiKeys from "@/server/handlers/v1/api-keys/route";
import * as apiKey from "@/server/handlers/v1/api-keys/[keyId]/route";
import { icon } from "../../components/icons";
import { proLink } from "../../components/pro-link";
import { timeAgo } from "../../components/time";
import { copyBtn } from "../../components/copy";
import { settingsAuth, settingsPage, type Html } from "./shell";

function loadKeys(workspaceId: string) {
  return db.query.apiKeys.findMany({
    where: eq(apiKeysTbl.workspace_id, workspaceId),
    orderBy: desc(apiKeysTbl.created_at),
    columns: { id: true, name: true, key_prefix: true, scopes: true, last_used_at: true, expires_at: true },
  });
}
type KeyRow = Awaited<ReturnType<typeof loadKeys>>[number];

/** "Publishing · 7 permissions": names the preset a key matches exactly, otherwise just counts. */
function scopeSummary(scopes: string[] | null): string {
  if (!scopes?.length) return "Full access";
  const set = new Set(scopes);
  const preset = API_SCOPE_PRESETS.find((p) => p.scopes.length === set.size && p.scopes.every((s) => set.has(s)));
  const n = `${scopes.length} permission${scopes.length === 1 ? "" : "s"}`;
  return set.size === API_SCOPES.length ? `All permissions · ${n}` : preset ? `${preset.label} · ${n}` : `Custom · ${n}`;
}

function renderKeys(keys: KeyRow[], error?: string): Html {
  const notice = error ? html`<div class="notice notice-err">${error}</div>` : html``;
  if (keys.length === 0) return html`${notice}<div class="empty"><p class="empty-title">No API keys yet</p><p class="empty-body">Create one for each script or agent, so you can revoke it on its own.</p></div>`;
  return html`${notice}<div class="table-wrap key-list">
    ${keys.map((k) => html`<div class="key-row">
      <div style="min-width:0"><div class="key-name">${k.name}</div><div class="muted mono key-prefix">${k.key_prefix}…</div></div>
      <div class="muted key-scopes" title="${k.scopes?.length ? k.scopes.join(", ") : "Full access"}">${scopeSummary(k.scopes)}</div>
      <div class="muted key-used">${k.last_used_at ? html`Used ${timeAgo(k.last_used_at)}` : "Never used"}${k.expires_at ? html`<br />Expires ${new Date(k.expires_at).toLocaleDateString()}` : ""}</div>
      <button class="btn btn-sm btn-danger" hx-delete="/settings/api-keys/${k.id}" hx-target="#keys-area" hx-swap="innerHTML" hx-confirm="Revoke ${k.name}? Scripts using it stop working." data-confirm-label="Revoke">Revoke</button>
    </div>`)}
  </div>`;
}

/** Resource rows for the compact Read/Write table: one row per resource, grouped like the catalog. */
const RESOURCE_LABELS: Record<string, string> = { sources: "Account sources", stats: "Analytics", media: "Media uploads" };
const resourceLabel = (r: string) => RESOURCE_LABELS[r] ?? r.charAt(0).toUpperCase() + r.slice(1);

function scopeMatrix(): Html {
  const cell = (scope: string | undefined, label: string) => scope
    ? html`<td><input data-api-scope type="checkbox" value="${scope}" x-model="scopes" aria-label="${label}" /></td>`
    : html`<td><span class="muted" aria-hidden="true">—</span></td>`;
  return html`<table class="scope-mx"><thead><tr><th scope="col">Resource</th><th scope="col">Read</th><th scope="col">Write</th></tr></thead><tbody>
    ${API_SCOPE_GROUPS.map((g) => {
      const defs = API_SCOPE_DEFINITIONS.filter((d) => d.group === g.id);
      const resources = [...new Set(defs.map((d) => d.scope.split(":")[0]))];
      return html`<tr class="scope-mx-group"><td colspan="3">${g.label}</td></tr>
        ${resources.map((r) => {
          const pick = (acc: string) => defs.find((d) => d.scope === `${r}:${acc}`);
          const read = pick("read"), write = pick("write");
          return html`<tr><td>${resourceLabel(r)}</td>${cell(read?.scope, read?.label ?? "")}${cell(write?.scope, write?.label ?? "")}</tr>`;
        })}`;
    })}
  </tbody></table>`;
}

/** Create sheet: a name, one of four access choices; the per-permission table shows only for Custom. */
function createSheet(): Html {
  const presets = Object.fromEntries(API_SCOPE_PRESETS.map(({ id, scopes }) => [id, scopes]));
  const state = JSON.stringify({ allScopes: API_SCOPES, presets, preset: "publishing", scopes: [...presets.publishing] });
  const choices = [
    ...API_SCOPE_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.description })),
    { id: "custom", label: "Custom", hint: "Choose permissions one by one." },
  ];
  return html`<dialog id="api-key-sheet" class="side-sheet" aria-labelledby="api-key-sheet-title">
    <form data-api-key-form hx-post="/settings/api-keys" hx-ext="json-enc" hx-target="#keys-area" hx-swap="innerHTML"
      x-data="${state}" @htmx:after-request="if ($event.detail.successful) { $el.closest('dialog').close(); $el.reset(); preset = 'publishing'; scopes = [...presets.publishing] }">
      <div class="side-sheet-head"><h2 id="api-key-sheet-title">Create API key</h2>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Close" @click="$el.closest('dialog').close()">${icon("close", "ico", 15)}</button></div>
      <div class="side-sheet-body">
        <label class="label" for="api-key-name">Name</label>
        <input class="input" id="api-key-name" name="name" placeholder="e.g. Content pipeline" required />
        <div class="label" id="api-key-access" style="margin-top:14px">What can this key do?</div>
        <div class="preset-cards" role="radiogroup" aria-labelledby="api-key-access">
          ${choices.map((p) => html`<label class="preset-card" :class="{ on: preset === '${p.id}' }">
            <input type="radio" name="preset" value="${p.id}" x-model="preset" @change="${raw(p.id === "custom" ? "" : `scopes = [...presets['${p.id}']]`)}" />
            <b>${p.label}</b><span>${p.hint}</span></label>`)}
        </div>
        <div x-show="preset === 'custom'" x-cloak>
          <div class="row" style="gap:6px;margin:4px 0 6px">
            <button class="btn btn-sm btn-ghost" type="button" @click="scopes = [...allScopes]">Select all</button>
            <button class="btn btn-sm btn-ghost" type="button" @click="scopes = []">Deselect all</button>
          </div>
          ${scopeMatrix()}
        </div>
      </div>
      <input type="hidden" name="scopes_json" :value="JSON.stringify(scopes)" />
      <div class="side-sheet-foot">
        <span class="muted" aria-live="polite" x-text="scopes.length + ' of ' + allScopes.length + ' permissions'"></span>
        <button class="btn" type="button" @click="$el.closest('dialog').close()">Cancel</button>
        <button class="btn btn-primary" type="submit" :disabled="scopes.length === 0">Create key</button>
      </div>
    </form>
  </dialog>`;
}

/** License gate for the API-keys tab. Shown instead of the keys UI on the free plan: states plainly
 *  what PRO unlocks, a buy CTA, and that free still works (license can be added later). */
function apiKeysUpsell(upgradeUrl: string): Html {
  const locked = [
    "REST API access — programmatic keys for agents & integrations",
    "First-comment automation",
    "Auto-Story publishing",
    "Drip sequences",
    "Contacts CRM",
    "Manual inbox replies",
  ];
  return html`<div class="upsell">
    <div class="upsell-head">${icon("lock", "ico", 18)}<h3>API access is a PRO feature</h3></div>
    <p class="upsell-lead">API keys and agent automations are part of PRO. On the free plan you create and schedule posts manually in the panel — without programmatic access.</p>
    <div class="upsell-sub">Without a license, these stay off:</div>
    <ul class="upsell-list">
      ${locked.map((f) => html`<li>${icon("lock", "ico", 14)}<span>${f}</span></li>`)}
    </ul>
    <div class="upsell-actions">
      <a class="btn btn-primary" href="${upgradeUrl}" target="_blank" rel="noopener">${icon("sparkles", "ico", 15)} Get PRO</a>
      <a class="btn btn-ghost" href="${upgradeUrl}" target="_blank" rel="noopener">See plans</a>
    </div>
    <div class="callout">${icon("info", "ico", 15)}<div>Free still works — create &amp; schedule posts manually. Already have a license? Add it in the <strong>License</strong> tab and API access unlocks instantly.</div></div>
  </div>`;
}

async function keysPage(c: Context): Promise<Response> {
  const a = await settingsAuth(c);
  if (!a) return c.redirect("/login");
  const license = await getInstanceLicense();
  if (!license.features.has("api_access")) {
    // Owner directive: unlicensed instances don't see the keys UI at all — only the upsell.
    return settingsPage(c, a, "/settings/api-keys", html`<section class="section"><h2>API keys ${proLink(license.upgradeUrl, "PRO")}</h2>${apiKeysUpsell(license.upgradeUrl)}</section>`);
  }
  return settingsPage(c, a, "/settings/api-keys", html`
    <div class="set-head"><p class="muted" style="margin:0;flex:1 1 260px">For your scripts and agents: <code>Authorization: Bearer ${BRAND.idPrefix}…</code> · <a href="/api/docs" target="_blank" rel="noopener">API docs</a></p>
      <button class="btn btn-primary" type="button" onclick="document.getElementById('api-key-sheet').showModal()">${icon("plus", "ico", 14)} Create API key</button></div>
    <div id="keys-area">${renderKeys(await loadKeys(a.workspaceId))}</div>
    ${createSheet()}`);
}

export function registerApiKeySettings(app: Hono, guard: MiddlewareHandler, jsonReq: (c: Context, body: unknown) => Request): void {
  app.get("/settings/api-keys", guard, keysPage);
  // API keys used to be a page of their own; keep deep links working.
  app.get("/api-keys", guard, (c) => c.redirect("/settings/api-keys"));

  app.post("/settings/api-keys", guard, async (c) => {
    // Transform the form (name + the scope checkboxes serialized to scopes_json) into the API's
    // JSON shape, so a dashboard key can be scoped instead of always full-access.
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let scopes: unknown = [];
    try { scopes = JSON.parse(typeof form.scopes_json === "string" ? form.scopes_json : "[]"); } catch { /* treated as empty */ }
    const picked = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
    const a = await settingsAuth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    // An empty scopes array is the full-access sentinel for programmatic keys, but in this form
    // deselecting every permission means the user wants no permissions. Require at least one.
    if (picked.length === 0) return c.html(renderKeys(await loadKeys(a.workspaceId), "Select at least one permission."));
    const res = await apiKeys.POST(jsonReq(c, { name: form.name ?? "", scopes: picked }));
    const body = await res.json().catch(() => ({}));
    const created = res.status === 201 ? body?.data?.key : null;
    const banner = created
      ? html`<div class="notice notice-ok key-created"><strong>Copy this key now. It won't be shown again.</strong>
          <div class="row" style="gap:8px;align-items:center;margin-top:6px"><code class="mono" style="overflow-wrap:anywhere">${created}</code>${copyBtn(created)}</div></div>`
      : res.status >= 400
        ? html`<div class="notice notice-err">${body?.error?.message ?? "Failed to create key."}</div>`
        : html``;
    return c.html(html`${banner}${renderKeys(await loadKeys(a.workspaceId))}`);
  });

  app.delete("/settings/api-keys/:id", guard, async (c) => {
    const id = c.req.param("id");
    const res = await apiKey.DELETE(c.req.raw, { params: Promise.resolve({ keyId: id }) }).catch(() => null);
    const a = await settingsAuth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const failed = !res || res.status >= 400
      ? ((await res?.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Could not revoke the API key."
      : undefined;
    return c.html(renderKeys(await loadKeys(a.workspaceId), failed));
  });
}
