import { html } from "hono/html";
import { BRAND } from "@/lib/brand";
import type { AlertWebhookConfig } from "@/lib/notifications/alert-webhook";
import type { ConfigStatus } from "@/lib/settings/config";
import { icon } from "../components/icons";
import { proLink } from "../components/pro-link";

type Html = ReturnType<typeof html>;

/**
 * The alert-webhook config form + summary (PRO), swapped in place by the save/remove routes. Custom
 * header VALUES are never echoed back — only their names. Headers are `Key: Value` lines; extra
 * payload fields a JSON object with {{placeholder}} tokens; field selection a comma list (blank = all).
 */
export function renderAlertWebhook(cfg: AlertWebhookConfig | null, canConfigure: boolean, upgradeUrl: string, msg?: string): Html {
  const notice = msg ? html`<div class="notice notice-ok">${msg}</div>` : html``;
  if (!canConfigure) {
    return html`${notice}<div class="callout">${icon("lock", "ico", 15)}<div>Configuring problem alerts is ${proLink(upgradeUrl, "PRO")}.</div></div>`;
  }
  const headerNames = cfg ? Object.keys(cfg.headers) : [];
  const extraCount = cfg ? Object.keys(cfg.extraFields).length : 0;
  const extraJson = extraCount ? JSON.stringify(cfg!.extraFields, null, 2) : "";
  const selection = cfg?.fieldSelection?.join(", ") ?? "";
  const mono = "font-family:var(--font-mono);font-size:12.5px";
  const summary = cfg
    ? html`<div class="row" style="align-items:center;gap:.5rem;margin-bottom:.4rem">
        <span class="badge tone-${cfg.enabled ? "ok" : "neutral"}">${cfg.enabled ? "Enabled" : "Disabled"}</span>
        <code class="mono grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cfg.url}</code>
        <button type="button" class="btn btn-sm" @click="open = !open" :aria-expanded="open">Edit</button>
      </div>
      <p class="muted" style="font-size:.78rem;margin:0 0 .5rem">${headerNames.length} custom header(s) · ${extraCount} extra field(s)</p>`
    : html`<p class="muted" style="font-size:.85rem;margin:0 0 .5rem">Not configured yet.</p>`;
  return html`${notice}${summary}
    <form x-show="open || ${cfg ? "false" : "true"}" x-cloak hx-post="/settings/alert-webhook" hx-ext="json-enc" hx-target="#alert-webhook-area" hx-swap="innerHTML" style="max-width:560px">
      <label class="fld"><span>Webhook URL</span>
        <input type="url" name="url" placeholder="https://hooks.example.com/alert" value="${cfg?.url ?? ""}" required style="${mono}" /></label>
      <label class="compose-toggle"><input type="checkbox" name="enabled" value="true" ${cfg ? (cfg.enabled ? "checked" : "") : "checked"} /><span>Enabled</span></label>
      <details ${cfg && (headerNames.length || extraCount || selection) ? "open" : ""}><summary class="muted" style="cursor:pointer;font-size:.85rem;margin:.5rem 0">Advanced: headers and message template</summary>
        <label class="fld"><span>Custom headers <small>— one <code>Key: Value</code> per line, encrypted at rest${headerNames.length ? html` · currently set: <strong>${headerNames.join(", ")}</strong> (re-enter to change)` : html``}</small></span>
          <textarea name="headers" rows="2" placeholder="Authorization: Bearer xxx&#10;X-Api-Key: yyy" style="${mono}"></textarea></label>
        <label class="fld"><span>Extra payload fields <small>— JSON; supports {{type}} {{display_name}} {{days_left}} {{detail}} {{expires_at}}</small></span>
          <textarea name="extra" rows="3" placeholder='{ "to": "ops@example.com", "subject": "${BRAND.name}: {{type}} ({{days_left}}d)" }' style="${mono}">${extraJson}</textarea></label>
        <label class="fld"><span>Only send these standard fields <small>— comma list, blank = all</small></span>
          <input name="selection" placeholder="type, display_name, detail" value="${selection}" style="${mono}" /></label>
      </details>
      <div class="row" style="gap:.5rem">
        <button class="btn btn-primary" type="submit">Save</button>
        ${cfg ? html`<button class="btn btn-sm btn-danger" type="button" hx-delete="/settings/alert-webhook" hx-target="#alert-webhook-area" hx-swap="innerHTML" hx-confirm="Remove the problem alerts webhook?" data-confirm-label="Remove">Remove</button>` : html``}
      </div>
    </form>`;
}

/** Installation fallback (CHANNEL_ALERT_WEBHOOK_URL), instance operators only: state + edit + clear through
 *  the existing /settings/credentials route (htmx, no swap; the page reloads to re-read every status). */
function fallbackRow(f: ConfigStatus): Html {
  const tone = f.source === "db" ? "ok" : f.source === "env" ? "info" : "neutral";
  const label = f.source === "db" ? "set here" : f.source === "env" ? "from env" : "not set";
  const post = html`hx-post="/settings/credentials" hx-ext="json-enc" hx-target="[data-alert-fallback-msg]" hx-swap="innerHTML" hx-on::after-request="if (event.detail.successful) location.reload()"`;
  return html`<div data-alert-fallback style="margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border)">
    <div class="row" style="align-items:center;gap:.5rem;flex-wrap:wrap"><strong style="font-size:.85rem">Installation fallback</strong><span class="badge tone-${tone}">${label}</span>${f.preview ? html`<code class="mono" style="overflow-wrap:anywhere">${f.preview}</code>` : html``}</div>
    <p class="muted" style="font-size:.78rem;margin:.25rem 0 .5rem">Used when the workspace alert above is off or not set. <code>CHANNEL_ALERT_WEBHOOK_URL</code>; a value set here overrides the environment variable.</p>
    <div data-alert-fallback-msg role="alert" class="muted" style="font-size:.8rem;margin-bottom:.4rem"></div>
    <form class="row" style="gap:.5rem;flex-wrap:wrap" ${post}>
      <input type="hidden" name="key" value="CHANNEL_ALERT_WEBHOOK_URL" />
      <input class="input input-sm" type="url" name="value" aria-label="Fallback webhook URL" placeholder="https://hooks.example.com/alert" autocomplete="off" required />
      <button class="btn btn-sm btn-primary" type="submit">Save fallback</button>
    </form>
    ${f.source === "db" ? html`<form style="margin-top:.4rem" ${post}><input type="hidden" name="key" value="CHANNEL_ALERT_WEBHOOK_URL" /><input type="hidden" name="clear" value="1" /><button class="btn btn-sm btn-danger" type="submit" title="Revert to the environment variable">Clear fallback</button></form>` : html``}
  </div>`;
}

/** Webhooks → Outgoing: the "Problem alerts" card. `fallback` (instance operators only) is the
 *  CHANNEL_ALERT_WEBHOOK_URL installation fallback status, editable here so it never goes invisible. */
export function problemAlertsCard(cfg: AlertWebhookConfig | null, canAlerts: boolean, upgradeUrl: string, fallback: ConfigStatus | null): Html {
  return html`<div class="card" style="margin-bottom:1rem" x-data="{ open: false }">
    <div class="row" style="align-items:center;gap:.5rem;margin-bottom:.25rem">
      <h3 style="margin:0">Problem alerts</h3>${canAlerts ? html`` : proLink(upgradeUrl, "PRO")}
    </div>
    <p class="muted" style="font-size:.85rem;margin-bottom:.75rem">We POST to your URL when something breaks: a channel needs re-login (plus the urgent nudge ~24h before access expires), a channel is degraded, a post delivery fails or is held, an incoming event could not be handled, or a token is nearing expiry. Add custom headers and templated fields to reach Slack, n8n or an email relay.</p>
    <div id="alert-webhook-area">${renderAlertWebhook(cfg, canAlerts, upgradeUrl)}</div>
    ${fallback ? fallbackRow(fallback) : html``}
  </div>`;
}
