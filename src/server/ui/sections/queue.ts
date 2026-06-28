import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { retryPost, cancelDelivery, type DeliveryRow } from "@/lib/deliveries/service";
import { getMedia, type MediaRow } from "@/lib/media/service";
import { ApiError } from "@/lib/api/response";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { renderPage } from "../layout";
import { statusBadge, pill, dot, type Tone } from "../components/status";
import { platformCell } from "../components/platform";
import { btn } from "../components/button";
import { icon } from "../components/icons";
import { urlLink, safeHttpUrl } from "../components/url";
import { relTime, fmtDate } from "../components/format";
import { isHtmx, toastHeader, type ToastTone } from "../components/toast";
import { listQueue, channelOptions, getQueueItem, type QueueRow, type QueueItem } from "./queue-data";

type Html = ReturnType<typeof html>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPT_BUDGET = 5;

const POST_STATUSES = [
  "failed", "held", "unknown", "scheduled", "sending", "sent", "canceled",
] as const satisfies readonly DeliveryRow["status"][];

const STATUS_TONE: Record<DeliveryRow["status"], Tone> = {
  scheduled: "info", sending: "info", sent: "ok", held: "warn",
  failed: "bad", unknown: "warn", canceled: "neutral",
};

function isPostStatus(s: string): s is DeliveryRow["status"] {
  return (POST_STATUSES as readonly string[]).includes(s);
}

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

function statusChips(active: string | undefined): Html {
  const chips = POST_STATUSES.map((s) => {
    const on = active === s;
    const href = on ? "/queue" : `/queue?status=${s}`;
    return html`<a class="count-chip ${on ? "is-on" : ""}" href="${href}">${pill(s, STATUS_TONE[s])}</a>`;
  });
  return html`<div class="counts-bar"><div class="counts-status">${chips}</div></div>`;
}

function filterBar(
  active: { status?: string; channelId?: string; format?: string },
  channels: { id: string; label: string }[],
  formats: string[],
): Html {
  const statusOpts = POST_STATUSES.map((s) => html`<option value="${s}"${active.status === s ? raw(" selected") : raw("")}>${s}</option>`);
  const channelOpts = channels.map((ch) => html`<option value="${ch.id}"${active.channelId === ch.id ? raw(" selected") : raw("")}>${ch.label}</option>`);
  const formatOpts = formats.map((f) => html`<option value="${f}"${active.format === f ? raw(" selected") : raw("")}>${f}</option>`);
  const hasFilters = !!(active.status || active.channelId || active.format);
  return html`<form class="filter-bar" method="get" action="/queue" role="search">
    <select name="status" aria-label="Filter by status"><option value="">All statuses</option>${statusOpts}</select>
    <select name="channel" aria-label="Filter by channel"><option value="">All channels</option>${channelOpts}</select>
    <select name="format" aria-label="Filter by format"><option value="">All formats</option>${formatOpts}</select>
    <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
    ${hasFilters ? html`<a class="filter-clear" href="/queue">Clear</a>` : ""}
  </form>`;
}

function timeCell(r: QueueRow): Html {
  return html`<span class="q-time"><span class="q-rel">${relTime(r.scheduledAt)}</span><small class="q-abs">${fmtDate(r.scheduledAt)}</small></span>`;
}
function attemptsCell(n: number): Html {
  return html`<span class="${n > 0 ? "q-att" : "q-att q-att-zero"}">${n}/${ATTEMPT_BUDGET}</span>`;
}
function errorCell(err: string | null): Html {
  if (!err) return html`<small>—</small>`;
  return html`<span class="q-err" title="${err}">${err}</span>`;
}

function rowHx(): ReturnType<typeof raw> {
  // Retry/cancel re-render the whole grouped tbody (not just the row) so the status-cluster headers
  // stay correct when an action moves a post between clusters; filters come from HX-Current-URL.
  return raw(`hx-target="#queue-rows" hx-swap="outerHTML"`);
}

function rowAction(r: QueueRow): Html {
  const act = `/queue/${r.id}`;
  if (r.status === "failed") {
    return html`<form method="post" action="${act}/retry" hx-post="${act}/retry" ${rowHx()} class="q-inline">
      <button class="btn btn-ic" type="submit" title="Retry" aria-label="Retry post">${icon("reconnect", "ico", 15)}</button>
    </form>`;
  }
  if (r.status === "scheduled" || r.status === "held") {
    return html`<form method="post" action="${act}/cancel" hx-post="${act}/cancel" ${rowHx()} class="q-inline"
      hx-confirm="Cancel this post? It will not be published." data-confirm-label="Cancel post">
      <button class="btn btn-ic" type="submit" title="Cancel" aria-label="Cancel post">${icon("close", "ico", 15)}</button>
    </form>`;
  }
  return html`<small>—</small>`;
}

function row(r: QueueRow): Html {
  const link = `/queue/${r.id}`;
  return html`<tr id="post-row-${r.id}">
    <td data-label="Time"><a class="row-link" href="${link}">${timeCell(r)}</a></td>
    <td data-label="Channel"><a class="row-link q-chcell" href="${link}">${platformCell(r.platform, r.metadata)}<span class="q-ch">${r.channelName}</span></a></td>
    <td data-label="Format"><span class="q-fmt">${r.format}</span></td>
    <td data-label="Status">${statusBadge(r.status)}</td>
    <td data-label="Attempts">${attemptsCell(r.attempts)}</td>
    <td data-label="Last error">${errorCell(r.lastError)}</td>
    <td data-label="Action" class="th-act">${rowAction(r)}</td>
  </tr>`;
}

// A status-keyed subheading so a mixed (unfiltered) queue reads as clusters — "Failed 3" then the rows.
function groupHead(status: DeliveryRow["status"], n: number): Html {
  return html`<tr class="row-group-head"><td colspan="7">${dot(STATUS_TONE[status])} ${status} <span class="muted">${n} ${n === 1 ? "post" : "posts"}</span></td></tr>`;
}

// Stable partition by status (preserves the query's urgency rank + each cluster's date order) → header + rows.
function groupedRows(rows: QueueRow[], grouped: boolean): Html[] {
  if (!grouped) return rows.map(row);
  const order: DeliveryRow["status"][] = [];
  const buckets = new Map<DeliveryRow["status"], QueueRow[]>();
  for (const r of rows) {
    let bucket = buckets.get(r.status);
    if (!bucket) { bucket = []; buckets.set(r.status, bucket); order.push(r.status); }
    bucket.push(r);
  }
  return order.flatMap((status) => [groupHead(status, buckets.get(status)!.length), ...buckets.get(status)!.map(row)]);
}

// The swappable <tbody> — shared by the page render and the retry/cancel re-render so group headers
// regroup after a status change. Cluster only an unfiltered, status-mixed view (a filtered view is one status).
function groupedTbody(rows: QueueRow[], status: DeliveryRow["status"] | undefined): Html {
  const grouped = !status && new Set(rows.map((r) => r.status)).size > 1;
  return html`<tbody id="queue-rows">
    ${rows.length === 0 ? html`<tr><td colspan="7" class="table-empty">No posts match these filters.</td></tr>` : groupedRows(rows, grouped)}
  </tbody>`;
}

async function queuePage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const ws = a.workspaceId;
  const url = new URL(c.req.url);
  const statusParam = url.searchParams.get("status") || undefined;
  const status = statusParam && isPostStatus(statusParam) ? statusParam : undefined;
  const channelId = url.searchParams.get("channel") || undefined;
  const format = url.searchParams.get("format")?.trim() || undefined;

  const [rows, channels, lic] = await Promise.all([
    listQueue({ workspaceId: ws, limit: 200, status, channelId, format }),
    channelOptions(ws),
    getInstanceLicense(),
  ]);

  const formats = [...new Set(rows.map((r) => r.format))].sort();
  const empty = rows.length === 0;
  const blankSlate = empty && !status && !channelId && !format;

  return c.html(
    renderPage({
      title: "Queue",
      nav: "queue",
      features: lic.features,
      products: lic.products,
      breadcrumb: `${rows.length} shown`,
      body: html`${statusChips(status)}
        ${filterBar({ status, channelId, format }, channels, formats)}
        ${blankSlate
          ? html`<div class="empty">
              <span class="empty-ic">${icon("queue", "ico", 20)}</span>
              <p class="empty-title">Nothing queued yet</p>
              <p class="empty-body">Scheduled and failed posts land here. Publish or schedule content from the composer.</p>
              ${btn({ label: "Open composer", href: "/compose", variant: "secondary", size: "sm", icon: "compose" })}
            </div>`
          : html`<div class="table-wrap">
              <table class="data-table" aria-label="Queued posts">
                <thead>
                  <tr>
                    <th scope="col">Time</th><th scope="col">Channel</th><th scope="col">Format</th>
                    <th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last error</th>
                    <th scope="col" class="th-act">Action</th>
                  </tr>
                </thead>
                ${groupedTbody(rows, status)}
              </table>
            </div>`}`,
    }),
  );
}

// ── detail ─────────────────────────────────────────────────────────────────────
function metaRow(label: string, value: Html | string): Html {
  return html`<div class="meta-row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function mediaPreview(media: MediaRow): Html {
  const dims = media.width && media.height ? `${media.width}×${media.height}` : null;
  const imgSrc = media.kind === "image" ? safeHttpUrl(media.url) : null;
  const thumb = imgSrc
    ? html`<img class="media-thumb" src="${imgSrc}" alt="" loading="lazy" />`
    : html`<div class="media-thumb media-thumb-video" aria-hidden="true">${icon("play", "ico", 18)}</div>`;
  return html`<div class="media-item">
    ${thumb}
    <div class="media-meta">
      <div class="media-kind">${media.kind}${media.mime ? html` · <span class="mode-tag">${media.mime}</span>` : ""}</div>
      <div class="media-dims">
        ${dims ? html`<span class="meta-mono">${dims}</span>` : ""}
        ${media.duration_sec ? html`<span class="meta-mono">${media.duration_sec}s</span>` : ""}
      </div>
    </div>
  </div>`;
}

function attemptTimeline(post: DeliveryRow): Html {
  return html`<dl class="meta-list">
    ${metaRow("Attempts", html`<span class="q-att">${post.attempts}/${ATTEMPT_BUDGET}</span>`)}
    ${metaRow("Scheduled", html`<span class="meta-mono">${fmtDate(post.scheduled_at)}</span> <small>${relTime(post.scheduled_at)}</small>`)}
    ${metaRow("Run at", post.run_at ? html`<span class="meta-mono">${fmtDate(post.run_at)}</span> <small>${relTime(post.run_at)}</small>` : html`<small>—</small>`)}
    ${metaRow("Last attempt", post.attempt_started_at ? html`<span class="meta-mono">${fmtDate(post.attempt_started_at)}</span> <small>${relTime(post.attempt_started_at)}</small>` : html`<small>never run</small>`)}
  </dl>`;
}

const HX_HEAD = `hx-target="#post-detail-head" hx-swap="outerHTML"`;

function detailActions(post: DeliveryRow): Html {
  const back = `/queue/${post.id}`;
  const retry = post.status === "failed"
    ? html`<form method="post" action="${back}/retry" hx-post="${back}/retry" ${raw(HX_HEAD)}>${btn({ label: "Retry", variant: "primary", icon: "reconnect" })}</form>`
    : "";
  const cancel = post.status === "scheduled" || post.status === "held"
    ? html`<form method="post" action="${back}/cancel" hx-post="${back}/cancel" ${raw(HX_HEAD)} hx-confirm="Cancel this post? It will not be published." data-confirm-label="Cancel post">${btn({ label: "Cancel", variant: "danger", icon: "close" })}</form>`
    : "";
  if (!retry && !cancel) return html``;
  return html`<div class="action-bar">${retry}${cancel}</div>`;
}

function postDetailHead(item: QueueItem): Html {
  const { post, channel, channelName } = item;
  const edge = STATUS_TONE[post.status];
  return html`<section class="detail-head tone-edge-${edge}" id="post-detail-head">
    <div class="detail-id">
      <span class="detail-glyph">${platformCell(channel.platform, channel.metadata)}</span>
      <div class="detail-name">
        <h2>${channelName}</h2>
        <div class="detail-sub">
          ${statusBadge(post.status)}
          <span class="mode-tag">${post.format}</span>
          <code class="detail-acct">${post.id}</code>
        </div>
      </div>
    </div>
    ${detailActions(post)}
  </section>`;
}


async function postDetailPage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const ws = a.workspaceId;
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return c.text("not found", 404);

  const item = await getQueueItem(ws, id);
  if (!item) return c.text("not found", 404);
  const { post, channelName } = item;
  const lic = await getInstanceLicense();

  const payload = post.payload as { media?: { mediaId?: string }[] } | null;
  const mediaIds = (payload?.media ?? [])
    .map((m) => m?.mediaId)
    .filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
  const medias = (await Promise.all(mediaIds.map((mid) => getMedia(mid, ws).catch(() => undefined)))).filter(
    (m): m is MediaRow => !!m,
  );

  const payloadJson = JSON.stringify(post.payload, null, 2);
  const header = postDetailHead(item);

  const errorPanel = post.last_error
    ? html`<section class="panel panel-error">
        <div class="panel-head"><h3>Last error</h3></div>
        <div class="panel-body"><p class="q-err-full">${post.last_error}</p></div>
      </section>`
    : "";

  const mediaPanel = medias.length
    ? html`<section class="panel">
        <div class="panel-head"><h3>Media</h3><span class="panel-count">${medias.length}</span></div>
        <div class="panel-body media-list">${medias.map(mediaPreview)}</div>
      </section>`
    : "";

  return c.html(
    renderPage({
      title: channelName,
      nav: "queue",
      features: lic.features,
      products: lic.products,
      breadcrumb: `Queue / ${post.id.slice(0, 8)}`,
      primaryAction: btn({ label: "All posts", href: "/queue", variant: "ghost" }),
      body: html`${header}
        ${errorPanel}
        <div class="detail-grid">
          <section class="panel">
            <div class="panel-head"><h3>Delivery</h3></div>
            ${attemptTimeline(post)}
          </section>
          <section class="panel">
            <div class="panel-head"><h3>References</h3></div>
            <dl class="meta-list">
              ${metaRow("Provider handle", post.provider_handle ? urlLink(post.provider_handle) : html`<small>—</small>`)}
              ${metaRow("Idempotency key", post.idempotency_key ? html`<code>${post.idempotency_key}</code>` : html`<small>—</small>`)}
            </dl>
          </section>
        </div>
        ${mediaPanel}
        <section class="panel">
          <div class="panel-head"><h3>Payload</h3></div>
          <pre class="payload">${payloadJson}</pre>
        </section>`,
    }),
  );
}

export function registerQueue(r: Hono, guard: MiddlewareHandler): void {
  r.get("/queue", guard, queuePage);
  r.get("/queue/:id", guard, postDetailPage);

  function action(run: (ws: string, id: string) => Promise<unknown>, toast: (post: DeliveryRow) => string) {
    return async (c: Context) => {
      const a = await auth(c);
      if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
      const id = c.req.param("id");
      if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
      try {
        await run(a.workspaceId, id);
      } catch (err) {
        if (err instanceof ApiError) return c.text(err.message, err.status as 400);
        throw err;
      }
      if (!isHtmx(c)) return c.redirect(`/queue/${id}`, 303);
      const item = await getQueueItem(a.workspaceId, id);
      if (!item) return c.text("not found", 404);
      const tone: ToastTone = STATUS_TONE[item.post.status] === "bad" ? "warn" : "ok";
      toastHeader(c, tone, toast(item.post));
      if (c.req.header("HX-Target") === "post-detail-head") return c.html(postDetailHead(item));
      // List page: re-render the grouped tbody for the page's current filters (from HX-Current-URL) so
      // the status-cluster headers regroup after this post changed status.
      const sp = new URL(c.req.header("HX-Current-URL") || "http://x/queue").searchParams;
      const sParam = sp.get("status") || undefined;
      const status = sParam && isPostStatus(sParam) ? sParam : undefined;
      const rows = await listQueue({ workspaceId: a.workspaceId, limit: 200, status, channelId: sp.get("channel") || undefined, format: sp.get("format")?.trim() || undefined });
      return c.html(groupedTbody(rows, status));
    };
  }

  r.post("/queue/:id/retry", guard, action((ws, id) => retryPost(id, ws), () => "Post re-queued"));
  r.post("/queue/:id/cancel", guard, action((ws, id) => cancelDelivery(id, ws), () => "Post canceled"));
}
