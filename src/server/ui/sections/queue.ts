import { registerTikTokConfirmation } from "./tiktok-confirmation";
import { rescheduleForm } from "../components/reschedule";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { retryPost, cancelDelivery, publishDeliveryNow, rescheduleDelivery, type DeliveryRow } from "@/lib/deliveries/service";
import { getMedia, type MediaRow } from "@/lib/media/service";
import { ApiError } from "@/lib/api/response";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { renderPage } from "../layout";
import { statusBadge, type Tone } from "../components/status";
import { platformCell } from "../components/platform";
import { btn } from "../components/button";
import { icon } from "../components/icons";
import { urlLink, safeHttpUrl } from "../components/url";
import { relTime, localTime } from "../components/format";
import { isHtmx, toastHeader, type ToastTone } from "../components/toast";
import { editDeliveryText } from "@/lib/content/service";
import { getQueueItem, resolveZone, type QueueItem } from "./queue-data";
import { currentListUrl, renderQueue } from "./queue-list";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outboundDeliveries } from "@/db/schema";
import { storyFallbackText } from "@/lib/stories/media";

type Html = ReturnType<typeof html>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPT_BUDGET = 5;
const TZ_COOKIE = "ps_tz";

const STATUS_TONE: Record<DeliveryRow["status"], Tone> = {
  scheduled: "info", sending: "info", processing: "info", sent: "ok", held: "warn",
  failed: "bad", unknown: "warn", canceled: "neutral",
};

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

async function queuePage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return isHtmx(c) ? c.body(null, 401, { "HX-Redirect": "/login" }) : c.redirect("/login");
  const tz = await resolveZone(getCookie(c, TZ_COOKIE));
  const lic = await getInstanceLicense();
  return c.html(
    renderPage({
      title: "Queue",
      nav: "queue",
      features: lic.features,
      products: lic.products,
      body: html`<div class="page q-page" data-view-tz="${tz}">
        <div class="q-head"><h1>Queue</h1>${btn({ label: "New post", href: "/compose", variant: "primary", size: "sm", icon: "plus" })}</div>
        ${await renderQueue(a.workspaceId, c.req.url, tz)}
      </div>`,
    }),
  );
}

// ── detail ─────────────────────────────────────────────────────────────────────
function metaRow(label: string, value: Html | string): Html {
  return html`<div class="meta-row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

/** The Story outcome of a post: clips of a split Story video, and its auto-Story with any card-fallback reason. */
async function storyRows(post: DeliveryRow): Promise<Html> {
  const clips = (post.payload as { _storyClipHandles?: string[] } | null)?._storyClipHandles?.length ?? 0;
  const story = await db.query.outboundDeliveries.findFirst({
    where: and(eq(outboundDeliveries.workspace_id, post.workspace_id), eq(outboundDeliveries.delivery_key, `auto-story:${post.id}`)),
    columns: { status: true, payload: true },
  });
  const detail = story?.payload as { storyFallbackReason?: string; storyClipHandles?: string[] } | undefined;
  const autoClips = detail?.storyClipHandles?.length ?? 0;
  return html`${clips > 1 ? metaRow("Story", `Published as ${clips} consecutive Instagram Stories`) : ""}
    ${story ? metaRow("Auto-Story", html`${story.status}${detail?.storyFallbackReason ? html` · <span data-story-fallback>${storyFallbackText(detail.storyFallbackReason)}</span>` : autoClips > 1 ? ` · ${autoClips} consecutive Stories` : ""}`) : ""}`;
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
    ${metaRow("Scheduled", html`<span class="meta-mono">${localTime(post.scheduled_at)}</span> <small>${relTime(post.scheduled_at)}</small>`)}
    ${metaRow("Run at", post.run_at ? html`<span class="meta-mono">${localTime(post.run_at)}</span> <small>${relTime(post.run_at)}</small>` : html`<small>—</small>`)}
    ${metaRow("Last attempt", post.attempt_started_at ? html`<span class="meta-mono">${localTime(post.attempt_started_at)}</span> <small>${relTime(post.attempt_started_at)}</small>` : html`<small>never run</small>`)}
  </dl>`;
}

const HX_HEAD = `hx-target="#post-detail-head" hx-swap="outerHTML"`;

const isPendingStatus = (s: string) => s === "scheduled" || s === "held";

function detailActions(post: DeliveryRow): Html {
  const back = `/queue/${post.id}`;
  const retry = post.status === "failed"
    ? html`<form method="post" action="${back}/retry" hx-post="${back}/retry" ${raw(HX_HEAD)} hx-confirm="Retry publishing this post now?" data-confirm-label="Retry">${btn({ label: "Retry", variant: "primary", icon: "reconnect" })}</form>`
    : "";
  const confirm = post.status === "held" && post.tiktok_confirmation === "required"
    ? html`<a class="btn btn-primary" href="${back}/confirm">Review TikTok settings</a>` : "";
  const cancel = ["scheduled", "held", "failed", "unknown"].includes(post.status)
    ? html`<form method="post" action="${back}/cancel" hx-post="${back}/cancel" ${raw(HX_HEAD)} hx-confirm="Cancel this post? It will not be published." data-confirm-label="Cancel post">${btn({ label: "Cancel", variant: "danger", icon: "close" })}</form>`
    : "";
  if (!retry && !cancel && !confirm) return html``;
  return html`<div class="action-bar">${confirm}${retry}${cancel}${cancel && !confirm && isPendingStatus(post.status) ? rescheduleForm(`${back}/reschedule`, "#post-detail-head") : ""}</div>`;
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
              ${await storyRows(post)}
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
  registerTikTokConfirmation(r, guard);
  r.get("/queue", guard, queuePage);
  r.get("/queue/:id", guard, postDetailPage);

  function action(run: (ws: string, id: string, c: Context) => Promise<unknown>, toast: (post: DeliveryRow) => string) {
    return async (c: Context) => {
      const a = await auth(c);
      if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
      const id = c.req.param("id");
      if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
      try {
        await run(a.workspaceId, id, c);
      } catch (err) {
        if (err instanceof ApiError) {
        toastHeader(c, "warn", err.message);
        return c.text(err.message, err.status as 400);
      }
        throw err;
      }
      if (!isHtmx(c)) return c.redirect(`/queue/${id}`, 303);
      const item = await getQueueItem(a.workspaceId, id);
      if (!item) return c.text("not found", 404);
      const tone: ToastTone = STATUS_TONE[item.post.status] === "bad" ? "warn" : "ok";
      toastHeader(c, tone, toast(item.post));
      if (c.req.header("HX-Target") === "post-detail-head") {
        if (c.req.path.endsWith("/reschedule")) c.header("HX-Refresh", "true");
        return c.html(postDetailHead(item));
      }
      const tz = await resolveZone(getCookie(c, TZ_COOKIE));
      return c.html(await renderQueue(a.workspaceId, currentListUrl(c.req.url, c.req.header("HX-Current-URL")), tz));
    };
  }

  r.post("/queue/:id/reschedule", guard, action(async (ws, id, c) => {
    const form = await c.req.parseBody();
    return rescheduleDelivery(id, ws, String(form.scheduledAt ?? ""));
  }, () => "Schedule changed."));
  r.post("/queue/:id/publish-now", guard, action((ws, id) => publishDeliveryNow(id, ws), () => "Post re-queued for publishing now"));
  r.post("/queue/:id/text", guard, action(async (ws, id, c) => {
    const form = await c.req.parseBody();
    return editDeliveryText(id, ws, String(form.text ?? ""));
  }, () => "Text saved."));
  r.post("/queue/:id/retry", guard, action((ws, id) => retryPost(id, ws), () => "Post re-queued"));
  r.post("/queue/:id/cancel", guard, action((ws, id) => cancelDelivery(id, ws), () => "Post canceled"));
}
