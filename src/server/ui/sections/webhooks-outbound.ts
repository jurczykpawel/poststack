import { localTime } from "../components/format";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { authenticateDashboard, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { ApiError } from "@/lib/api/response";
import { listWebhookDeliveries } from "@/lib/webhooks/deliveries";
import { EVENT_TYPES } from "@/lib/events";
import {
  createEndpoint, getEndpoint, listEndpoints, updateEndpoint, rotateSecret, deleteEndpoint,
  type WebhookEndpoint,
} from "@/lib/webhooks/endpoints";
import { parseHeaderLines, type HeaderMap } from "@/lib/webhooks/header-map";
import { isHtmx, toastHeader } from "../components/toast";
import { icon } from "../components/icons";

type Html = ReturnType<typeof html>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONO = "font-family:var(--font-mono);font-size:12.5px";
type EndpointField = "url" | "event_types" | "headers" | "extra";
const addErrorId = (field: EndpointField) => `wh-add-error-${field}`;
const addErrorSlot = (field: EndpointField) => html`<div id="${addErrorId(field)}"></div>`;
function addErrorAttributes(field: EndpointField): Html {
  const id = addErrorId(field);
  return html`data-wh-error="${id}" :aria-invalid="fieldError === '${id}'"
    :aria-describedby="fieldError === '${id}' ? fieldError : null"`;
}

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticateDashboard(c.req.raw).catch(() => null);
}

/** Pull the (possibly repeated) `event_types` checkbox values + url + headers/extra textareas out of a form body. */
async function readEndpointForm(
  c: Context,
): Promise<{ url: string; eventTypes: string[]; headersRaw: string; extraRaw: string }> {
  const body = await c.req.parseBody({ all: true });
  const url = String(body.url ?? "").trim();
  const raw = body.event_types;
  const eventTypes = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw])
    .map((v) => String(v).trim())
    .filter(Boolean);
  const headersRaw = typeof body.headers === "string" ? body.headers : "";
  const extraRaw = typeof body.extra === "string" ? body.extra : "";
  return { url, eventTypes, headersRaw, extraRaw };
}

/** Parse the "extra payload fields" JSON textarea. Blank -> {}. Throws ApiError(422) on bad JSON —
 *  callers already catch ApiError from create/updateEndpoint and surface `.message` as an inline notice. */
function parseExtraFields(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value: unknown) => {
      if (key.includes("\0") || (typeof value === "string" && value.includes("\0"))) {
        throw new ApiError("invalid_request", "Extra payload fields must not contain NUL characters.", 422);
      }
      return value;
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("invalid_request", "Extra payload fields must be valid JSON — nothing saved.", 422);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("invalid_request", "Extra payload fields must be a JSON object — nothing saved.", 422);
  }
  return parsed as Record<string, unknown>;
}

/** "All events" when nothing is selected, otherwise the explicit subscription list. */
function eventsLabel(ep: WebhookEndpoint): Html {
  const types = ep.event_types ?? [];
  if (types.length === 0) return html`<span class="badge tone-info">All events</span>`;
  return html`${types.map((t) => html`<span class="badge tone-neutral" style="margin:0 .2rem .2rem 0">${t}</span>`)}`;
}

/** The per-EVENT_TYPES checkbox grid; pre-checks any type already on the endpoint. */
function eventChecks(selected: ReadonlySet<string>, idPrefix: string): Html {
  return html`<div class="wh-events-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:.25rem .75rem;margin:.35rem 0">
    ${EVENT_TYPES.map((t) => html`<label class="compose-toggle" style="font-size:.82rem">
      <input type="checkbox" name="event_types" value="${t}" ${selected.has(t) ? "checked" : ""} id="${idPrefix}-${t}" />
      <span class="mono">${t}</span>
    </label>`)}
  </div>`;
}

/**
 * Custom headers + extra payload fields inputs, shared by the add-form and each card's edit-form
 * (DRY, mirrors the alert webhook's Settings form). Header VALUES are never echoed back — only the
 * configured NAMES (`headerNames`), so the operator knows what's set without leaking secrets. Extra
 * fields aren't secret, so `extraJson` prefills the textarea with the current value.
 */
function headerAndExtraFields(headerNames: string[], extraJson: string, add = false): Html {
  return html`<label class="fld"><span>Custom headers <small>— one <code>Key: Value</code> per line, encrypted at rest${headerNames.length ? html` · currently set: <strong>${headerNames.join(", ")}</strong> (re-enter to change)` : html``}</small></span>
      <textarea name="headers" rows="2" placeholder="Authorization: Bearer xxx&#10;X-Api-Key: yyy" style="${MONO}" ${add ? addErrorAttributes("headers") : ""}></textarea></label>
    ${add ? addErrorSlot("headers") : ""}
    <label class="fld"><span>Extra payload fields <small>— JSON; supports {{id}} {{type}} {{created_at}} {{subject_id}} {{subject_type}}</small></span>
      <textarea name="extra" rows="3" placeholder='{ "source": "poststack" }' style="${MONO}" ${add ? addErrorAttributes("extra") : ""}>${extraJson}</textarea></label>
    ${add ? addErrorSlot("extra") : ""}`;
}

/** One endpoint card: url, events, active toggle, revealable secret, edit form, rotate, delete. */
function endpointCard(ep: WebhookEndpoint, highlight: boolean): Html {
  const selected = new Set(ep.event_types ?? []);
  const headerNames = Object.keys(ep.headers);
  const extraFields = ep.extra_payload_fields as Record<string, unknown>;
  const extraJson = Object.keys(extraFields).length ? JSON.stringify(extraFields, null, 2) : "";
  return html`<div class="card${highlight ? " wh-just-created" : ""}" style="margin:.6rem 0${highlight ? ";border-color:var(--accent)" : ""}">
    <div class="row" style="align-items:center;gap:.5rem">
      <span class="badge tone-${ep.active ? "ok" : "neutral"}">${ep.active ? "Active" : "Inactive"}</span>
      <code class="mono grow" style="overflow-x:auto;white-space:nowrap">${ep.url}</code>
    </div>
    <div class="muted" style="font-size:.82rem;margin:.4rem 0 .2rem">Events: ${eventsLabel(ep)}</div>
    ${highlight ? html`<div class="row" style="align-items:center;gap:.4rem;font-size:.8rem" x-data="{ show: true }">
      <span class="muted">Signing secret:</span>
      <code class="mono" x-ref="sec" x-show="show" x-cloak style="overflow-x:auto;white-space:nowrap">${ep.secret}</code>
      <code class="mono" x-show="!show">whsec_••••••••••••</code>
      <button type="button" class="btn btn-sm btn-ghost" @click="show = !show" x-text="show ? 'Hide' : 'Reveal'">Reveal</button>
      <button type="button" class="btn btn-sm btn-ghost" @click="navigator.clipboard && navigator.clipboard.writeText($refs.sec.textContent)">Copy</button>
    </div>` : html`<div class="row" style="font-size:.8rem"><span class="muted">Signing secret:</span> <code class="mono">whsec_••••••••••••</code></div>`}
    <div class="row" style="gap:.4rem;margin-top:.5rem;flex-wrap:wrap">
      <button class="btn btn-sm" hx-post="/webhooks/outbound/${ep.id}/toggle" hx-target="#wh-outbound" hx-swap="outerHTML"${ep.active ? raw(' hx-confirm="Disable this endpoint? Pending deliveries to it will be dropped." data-confirm-label="Disable"') : raw("")}>${ep.active ? "Disable" : "Enable"}</button>
      <button class="btn btn-sm" hx-post="/webhooks/outbound/${ep.id}/rotate" hx-target="#wh-outbound" hx-swap="outerHTML" hx-confirm="Rotate the signing secret? The previous secret keeps signing for 24 hours." data-confirm-label="Rotate">${icon("reconnect", "ico", 13)} Rotate secret</button>
      <button class="btn btn-sm btn-danger" hx-delete="/webhooks/outbound/${ep.id}" hx-target="#wh-outbound" hx-swap="outerHTML" hx-confirm="Delete this endpoint? Future events will no longer be delivered to it." data-confirm-label="Delete">Delete</button>
    </div>
    <details style="margin-top:.5rem" data-webhook-deliveries="${ep.id}">
      <summary style="cursor:pointer;font-size:.82rem;font-weight:600">Recent deliveries</summary>
      <div id="wh-deliveries-${ep.id}" hx-get="/webhooks/outbound/${ep.id}/deliveries" hx-trigger="revealed" hx-swap="innerHTML transition:false"></div>
    </details>
    <details style="margin-top:.5rem">
      <summary style="cursor:pointer;font-size:.82rem;font-weight:600">Edit URL, events &amp; headers</summary>
      <form hx-post="/webhooks/outbound/${ep.id}" hx-target="#wh-outbound" hx-swap="outerHTML" style="margin-top:.5rem">
        <label class="fld"><span>Endpoint URL</span>
          <input type="url" name="url" value="${ep.url}" required style="${MONO}" /></label>
        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:.5rem .6rem;margin:.4rem 0">
          <legend style="font-size:.8rem;padding:0 .3rem">Events <small class="muted">— none checked = all events</small></legend>
          ${eventChecks(selected, `edit-${ep.id}`)}
        </fieldset>
        ${headerAndExtraFields(headerNames, extraJson)}
        <button class="btn btn-sm btn-primary" type="submit">Save changes</button>
      </form>
    </details>
  </div>`;
}

/**
 * The whole `#wh-outbound` panel (htmx replaces this node via outerHTML on every action). Free
 * instances see a PRO prompt; entitled instances get the add-form + the endpoint list. `highlightId`
 * marks (and auto-reveals the secret of) a just-created/rotated endpoint.
 */
export function renderOutboundWebhooks(
  endpoints: WebhookEndpoint[],
  opts: { canManage: boolean; upgradeUrl: string; notice?: string; noticeError?: boolean; highlightId?: string },
): Html {
  const notice = opts.notice ? html`<div class="notice ${opts.noticeError ? "notice-err" : "notice-ok"}">${opts.notice}</div>` : html``;
  if (!opts.canManage) {
    return html`<div id="wh-outbound">${notice}
      <div class="callout">${icon("lock", "ico", 15)}<div>Outbound webhook endpoints are a <a href="${opts.upgradeUrl}">PRO</a> feature. Subscribe an external URL (n8n, Zapier, your own service) to events — each delivery is HMAC-signed with a per-endpoint secret.</div></div>
    </div>`;
  }
  return html`<div id="wh-outbound" x-data @htmx:before-swap.self="if ($event.detail.xhr.status === 404) $event.detail.shouldSwap = true">${notice}
    <details class="card" style="margin:.6rem 0">
      <summary style="cursor:pointer;font-weight:600">${icon("plus", "ico", 14)} Add an endpoint</summary>
      <form method="post" action="/webhooks/outbound" hx-post="/webhooks/outbound" hx-target="#wh-outbound" hx-swap="outerHTML" hx-disabled-elt="find button[type=submit]" style="margin-top:.6rem"
        x-data="{ fieldError: '' }"
        @htmx:before-request="if (fieldError) document.getElementById(fieldError).replaceChildren(); fieldError = ''"
        @htmx:after-request="if ($event.detail.xhr.status === 422) {
          fieldError = $event.detail.target.id;
          $nextTick(() => $el.querySelector('[data-wh-error=' + fieldError + ']')?.focus());
        }">
        <label class="fld"><span>Endpoint URL</span>
          <input type="url" name="url" placeholder="https://hooks.example.com/poststack" required style="${MONO}" ${addErrorAttributes("url")} /></label>
        ${addErrorSlot("url")}
        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:.5rem .6rem;margin:.4rem 0" tabindex="-1" ${addErrorAttributes("event_types")}>
          <legend style="font-size:.8rem;padding:0 .3rem">Subscribe to events <small class="muted">— leave all unchecked to receive every event</small></legend>
          ${eventChecks(new Set<string>(), "new")}
          ${addErrorSlot("event_types")}
        </fieldset>
        ${headerAndExtraFields([], "", true)}
        <button class="btn btn-primary" type="submit">${icon("plus", "ico", 14)} Add endpoint</button>
      </form>
    </details>
    ${endpoints.length === 0
      ? html`<p class="muted" style="font-size:.85rem">No outbound endpoints yet. Add one above to receive HMAC-signed event deliveries.</p>`
      : html`${endpoints.map((ep) => endpointCard(ep, ep.id === opts.highlightId))}`}
  </div>`;
}

/** The lazy-load placeholder dropped into the Webhooks page's "outgoing" tab. */
export function outboundWebhooksMount(): Html {
  return html`<div id="wh-outbound" hx-get="/webhooks/outbound" hx-trigger="load" hx-swap="outerHTML">
    <p class="muted" style="font-size:.82rem">Loading outbound endpoints…</p>
  </div>`;
}

export function registerWebhooksOutbound(r: Hono, guard: MiddlewareHandler): void {
  // Resolve session + license once per request; every handler is workspace-scoped + PRO-gated to
  // exactly match /api/v1/webhooks (proGate("outbound_webhooks")).
  async function ctx(c: Context): Promise<{ a: AuthContext; canManage: boolean; upgradeUrl: string } | Response> {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { features, upgradeUrl } = await getInstanceLicense();
    return { a, canManage: features.has("outbound_webhooks"), upgradeUrl };
  }

  async function renderPanel(workspaceId: string, canManage: boolean, upgradeUrl: string, extra?: { notice?: string; noticeError?: boolean; highlightId?: string }) {
    const endpoints = canManage ? await listEndpoints(workspaceId) : [];
    return renderOutboundWebhooks(endpoints, { canManage, upgradeUrl, ...extra });
  }

  async function missingEndpoint(c: Context, workspaceId: string, upgradeUrl: string) {
    const notice = "This webhook endpoint no longer exists.";
    if (!isHtmx(c)) return c.text(notice, 404);
    toastHeader(c, "bad", notice);
    c.header("HX-Retarget", "#wh-outbound");
    c.header("HX-Reswap", "outerHTML");
    return c.html(await renderPanel(workspaceId, true, upgradeUrl, { notice, noticeError: true }), 404);
  }

  r.get("/webhooks/outbound", guard, async (c) => {
    if (!isHtmx(c)) return c.redirect("/webhooks#outgoing");
    const g = await ctx(c);
    if (g instanceof Response) return g;
    return c.html(await renderPanel(g.a.workspaceId, g.canManage, g.upgradeUrl));
  });

  r.get("/webhooks/outbound/:id/deliveries", guard, async (c) => {
    const g = await ctx(c);
    if (g instanceof Response) return g;
    if (!g.canManage) return c.text("PRO feature", 402);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
    const result = await listWebhookDeliveries(g.a.workspaceId, id, 20, c.req.query("cursor")).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    if (!result) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
    const { items, meta } = result;
    return c.html(html`
      <button class="btn btn-sm" hx-get="/webhooks/outbound/${id}/deliveries" hx-target="#wh-deliveries-${id}" hx-swap="innerHTML transition:false">Refresh deliveries</button>
      ${items.length ? items.map((d) => html`<article class="card" style="margin:.5rem 0;overflow-wrap:anywhere" data-delivery-id="${d.id}">
        <strong>${d.event_type}</strong> · <span class="badge tone-${d.status === "delivered" ? "ok" : d.status === "failed" ? "bad" : "neutral"}">${d.status}</span>
        <dl>
          <dt>Event ID</dt><dd class="mono">${d.event_id}</dd>
          <dt>Created</dt><dd>${localTime(d.created_at)}</dd>
          <dt>Last update</dt><dd>${localTime(d.updated_at)}</dd>
          <dt>HTTP status</dt><dd>${d.http_status ?? "—"}</dd>
          <dt>Attempts</dt><dd>${d.attempts}</dd>
          <dt>Last error</dt><dd>${d.last_error ?? "—"}</dd>
          <dt>Next attempt</dt><dd>${d.next_attempt_at ?? "—"}</dd>
        </dl>
      </article>`) : html`<p class="muted">No deliveries yet.</p>`}
      ${meta.next_cursor ? html`<button class="btn btn-sm" hx-get="/webhooks/outbound/${id}/deliveries?cursor=${meta.next_cursor}" hx-target="#wh-deliveries-${id}" hx-swap="innerHTML transition:false">Older deliveries</button>` : ""}
    `);
  });

  // Create — empty event_types ⇒ subscribe to ALL events. Surfaces the freshly-minted secret once
  // (auto-revealed on the new card). Validation errors update only the corresponding field.
  r.post("/webhooks/outbound", guard, async (c) => {
    const g = await ctx(c);
    if (g instanceof Response) return g;
    if (!g.canManage) return c.html(await renderPanel(g.a.workspaceId, false, g.upgradeUrl));
    const { url, eventTypes, headersRaw, extraRaw } = await readEndpointForm(c);
    let field: EndpointField = "extra";
    try {
      const extraFields = parseExtraFields(extraRaw);
      field = "headers";
      const headers: HeaderMap = parseHeaderLines(headersRaw);
      field = "url";
      const ep = await createEndpoint(g.a.workspaceId, { url, eventTypes, headers, extraFields });
      return c.html(await renderPanel(g.a.workspaceId, true, g.upgradeUrl, {
        notice: "Endpoint added — reveal the signing secret below and store it now.",
        highlightId: ep.id,
      }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const validationField = err.details?.[0]?.path;
        if (validationField === "event_types" || validationField === "headers") field = validationField;
        toastHeader(c, "bad", err.message);
        c.header("HX-Retarget", `#${addErrorId(field)}`);
        c.header("HX-Reswap", "innerHTML");
        return c.html(html`<div class="notice notice-err">${err.message}</div>`, 422);
      }
      throw err;
    }
  });

  // Edit url + event-type selection + headers/extra fields.
  r.post("/webhooks/outbound/:id", guard, async (c) => {
    const g = await ctx(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    if (!g.canManage) return c.html(await renderPanel(g.a.workspaceId, false, g.upgradeUrl));
    const { url, eventTypes, headersRaw, extraRaw } = await readEndpointForm(c);
    try {
      const extraFields = parseExtraFields(extraRaw); // blank textarea -> {} (visible, so blank = clear)
      const headerLines = parseHeaderLines(headersRaw);
      // Blank textarea (no parsed keys) -> leave existing headers untouched (values are never echoed
      // back, so a blank submission almost certainly means "didn't intend to change them").
      const headers = Object.keys(headerLines).length ? headerLines : undefined;
      await updateEndpoint(g.a.workspaceId, id, { url, eventTypes, headers, extraFields });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
      if (err instanceof ApiError) {
        toastHeader(c, "bad", err.message);
        return c.html(await renderPanel(g.a.workspaceId, true, g.upgradeUrl, { notice: err.message, noticeError: true }), err.status === 422 ? 422 : 200);
      }
      throw err;
    }
    return c.html(await renderPanel(g.a.workspaceId, true, g.upgradeUrl, { notice: "Endpoint updated." }));
  });

  // Toggle active.
  r.post("/webhooks/outbound/:id/toggle", guard, async (c) => {
    const g = await ctx(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    if (!g.canManage) return c.html(await renderPanel(g.a.workspaceId, false, g.upgradeUrl));
    let ep;
    try {
      const found = await getEndpoint(g.a.workspaceId, id);
      if (!found) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
      ep = await updateEndpoint(g.a.workspaceId, id, { active: !found.active });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
      throw err;
    }
    return c.html(await renderPanel(g.a.workspaceId, true, g.upgradeUrl, { notice: ep.active ? "Endpoint enabled." : "Endpoint disabled." }));
  });

  // Rotate the signing secret (auto-reveals the new one on its card).
  r.post("/webhooks/outbound/:id/rotate", guard, async (c) => {
    const g = await ctx(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    if (!g.canManage) return c.html(await renderPanel(g.a.workspaceId, false, g.upgradeUrl));
    try {
      await rotateSecret(g.a.workspaceId, id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
      throw err;
    }
    return c.html(await renderPanel(g.a.workspaceId, true, g.upgradeUrl, { notice: "Secret rotated — reveal and store the new one.", highlightId: id }));
  });

  // Delete (hx-confirm on the button).
  r.delete("/webhooks/outbound/:id", guard, async (c) => {
    const g = await ctx(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    if (!g.canManage) return c.html(await renderPanel(g.a.workspaceId, false, g.upgradeUrl));
    try {
      await deleteEndpoint(g.a.workspaceId, id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return missingEndpoint(c, g.a.workspaceId, g.upgradeUrl);
      throw err;
    }
    return c.html(await renderPanel(g.a.workspaceId, true, g.upgradeUrl, { notice: "Endpoint deleted." }));
  });
}
