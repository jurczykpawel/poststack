import type { Hono, MiddlewareHandler, Context } from "hono";
import { every } from "hono/combine";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { and, or, eq, gt, asc, desc, ilike, like, exists, inArray, sql, count, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  conversations, messages, messageReactions, postReactions, channels, contacts, contactChannels,
  apiKeys as apiKeysTbl, autoReplyRules, sequences as sequencesTbl, sequenceEnrollments, workspaces,
  pendingApprovals, commentLogs, events as eventsTbl, webhookEvents,
} from "@/db/schema";
import { authenticate, type AuthContext } from "@/lib/auth";
import { MAX_RETENTION_DAYS } from "@/lib/retention";
import { env } from "@/lib/env";
import { BRAND } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { getInstanceLicense, setLicense, clearLicense, licenseRejectionMessage, type LicenseState } from "@/lib/license/gate";
import { getAlertWebhook, upsertAlertWebhook, deleteAlertWebhook, type AlertWebhookConfig } from "@/lib/notifications/alert-webhook";
import type { Feature } from "@/lib/license/features";
import { loadOverview } from "@/lib/stats/overview";
import * as channelConnectToken from "@/server/handlers/v1/channels/connect-token/route";
import * as channelTelegram from "@/server/handlers/v1/channels/telegram/route";
import * as conversationMessages from "@/server/handlers/v1/conversations/[conversationId]/messages/route";
import * as conversation from "@/server/handlers/v1/conversations/[conversationId]/route";
import * as rules from "@/server/handlers/v1/rules/route";
import * as rule from "@/server/handlers/v1/rules/[ruleId]/route";
import * as approvalApprove from "@/server/handlers/v1/approvals/[approvalId]/approve/route";
import * as approvalReject from "@/server/handlers/v1/approvals/[approvalId]/reject/route";
import * as sequences from "@/server/handlers/v1/sequences/route";
import * as sequence from "@/server/handlers/v1/sequences/[sequenceId]/route";
import * as apiKeys from "@/server/handlers/v1/api-keys/route";
import * as apiKey from "@/server/handlers/v1/api-keys/[keyId]/route";
import { dashboardDoc } from "../ui/layout";
import { requireSameOrigin } from "../middleware/same-origin";
import { registerChannels } from "../ui/sections/channels";
import { registerCompose } from "../ui/sections/compose";
import { registerContent } from "../ui/sections/content";
import { registerBrands } from "../ui/sections/brands";
import { listBrands } from "@/lib/brands/service";
import { registerSources } from "../ui/sections/sources";
import { registerQueue } from "../ui/sections/queue";
import { gatherAttention, upcomingScheduled, recentEvents, type AttentionRow, type UpcomingPost, type RecentEvent } from "../ui/sections/dashboard-data";
import { dot, pill as pillBadge, type Tone } from "../ui/components/status";
import { kpi } from "../ui/components/kpi";
import { listProviders } from "@/lib/providers";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// ─── helpers ──────────────────────────────────────────────────────────────────

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

/** Build a JSON Request carrying the caller's cookie/Authorization, for delegating
 * to an API handler that expects a structured JSON body. */
function jsonReq(c: Context, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = c.req.header("cookie");
  const authz = c.req.header("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authz) headers.set("authorization", authz);
  return new Request(c.req.url, { method: "POST", headers, body: JSON.stringify(body) });
}

function timeAgo(iso: string | Date | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ─── inbox ────────────────────────────────────────────────────────────────────

type ConvName = {
  contact: { display_name: string | null; contact_channels: Array<{ platform_username: string | null; platform_sender_id: string }> };
};
function contactName(c: ConvName): string {
  return (
    c.contact.display_name ??
    c.contact.contact_channels[0]?.platform_username ??
    c.contact.contact_channels[0]?.platform_sender_id ??
    "Unknown"
  );
}

const CONV_QUERY = {
  columns: {
    id: true, platform: true, status: true, last_message_at: true,
    last_message_preview: true, unread_count: true, thread_type: true, thread_ref: true,
    // Surfaced as inbox controls / indicators.
    is_automation_paused: true, needs_manual_reply: true, assigned_to: true,
  },
  with: {
    channel: { columns: { id: true, display_name: true, platform: true } },
    contact: {
      columns: { id: true, display_name: true, avatar_url: true },
      with: { contact_channels: { columns: { platform_sender_id: true, platform_username: true }, limit: 1 } },
    },
  },
} as const;

export type ConvFilter = "all" | "needs_reply" | "unread" | "dm" | "comment";
const CONV_FILTERS: { id: ConvFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs_reply", label: "Needs reply" },
  { id: "unread", label: "Unread" },
  { id: "dm", label: "DMs" },
  { id: "comment", label: "Comments" },
];
export function parseConvFilter(v: string | undefined): ConvFilter {
  return CONV_FILTERS.some((f) => f.id === v) ? (v as ConvFilter) : "all";
}

/** Just the conversation rows (htmx swaps this when a filter tab is clicked). */
function renderConvItems(conversations: Array<Awaited<ReturnType<typeof loadConversations>>[number]>): Html {
  if (conversations.length === 0) {
    return html`<p class="muted" style="padding:1rem">Nothing here. Try another filter, or wait for new activity.</p>`;
  }
  return html`${conversations.map((conv) => {
    const isComment = conv.thread_type === "comment";
    return html`<button class="conv-item" hx-get="/inbox/${conv.id}" hx-target="#thread" hx-swap="innerHTML">
      <div class="conv-top">
        <span class="conv-name ${conv.unread_count > 0 ? "unread" : ""}"><span title="${isComment ? "Comment thread" : "Direct message"}">${isComment ? "💬" : "✉️"}</span> ${contactName(conv)}</span>
        <span class="conv-time">${timeAgo(conv.last_message_at)}</span>
      </div>
      ${isComment ? html`<div class="muted" style="font-size:.68rem">comment${conv.needs_manual_reply ? " · ⚠ needs reply" : ""}</div>` : conv.needs_manual_reply ? html`<div class="muted" style="font-size:.68rem">⚠ needs reply</div>` : html``}
      <div class="conv-preview">${conv.last_message_preview ?? "No messages"}</div>
      ${conv.unread_count > 0 ? html`<span class="badge">${conv.unread_count}</span>` : html``}
    </button>`;
  })}`;
}

type InboxChannel = Awaited<ReturnType<typeof loadInboxChannels>>[number];

/** The inbox left panel: filter tabs + a channel dropdown + the rows. Tabs carry the current channel
 *  and the dropdown carries the current filter, and both re-render the whole panel (#conv-panel), so
 *  the two filters compose and their selected state always stays in sync. */
function renderConvPanel(
  conversations: Array<Awaited<ReturnType<typeof loadConversations>>[number]>,
  filter: ConvFilter,
  channelId: string,
  chans: InboxChannel[],
): Html {
  return html`<div class="conv-head" style="display:flex;justify-content:space-between;align-items:center">
      <span>Inbox</span>
      <button class="btn btn-sm" title="Refresh the list (also pulls the latest into view)" style="font-size:.75rem;padding:.1rem .45rem"
        hx-get="/inbox/list?filter=${filter}&channel=${channelId}" hx-target="#conv-panel" hx-swap="innerHTML">↻</button>
    </div>
    <div class="conv-filters" style="display:flex;gap:.25rem;flex-wrap:wrap;padding:.4rem .5rem;border-bottom:1px solid var(--border,#222)">
      ${CONV_FILTERS.map(
        (f) => html`<button class="btn btn-sm ${f.id === filter ? "btn-primary" : ""}" style="font-size:.72rem;padding:.15rem .5rem"
          hx-get="/inbox/list?filter=${f.id}&channel=${channelId}" hx-target="#conv-panel" hx-swap="innerHTML">${f.label}</button>`,
      )}
    </div>
    ${chans.length > 1
      ? html`<div style="padding:.35rem .5rem;border-bottom:1px solid var(--border,#222)">
          <select class="input" name="channel" style="font-size:.75rem;width:100%;padding:.25rem"
            hx-get="/inbox/list" hx-target="#conv-panel" hx-swap="innerHTML" hx-trigger="change"
            hx-vals='${`{"filter":"${filter}"}`}'>
            <option value="all" ${channelId === "all" ? "selected" : ""}>All channels</option>
            ${renderInboxChannelOptions(chans, channelId)}
          </select>
        </div>`
      : html``}
    <div id="conv-list-items">${renderConvItems(conversations)}</div>`;
}

/** Inbox channel <option>s, grouped into <optgroup>s by owning brand (brand-aware reply filter —
 *  UNIFY1 Task 4: the SAME brand groups publish AND reply channels). Channels without a brand fall
 *  into an "Unassigned" group. With no brands assigned at all, renders a flat option list. */
function renderInboxChannelOptions(chans: InboxChannel[], channelId: string): Html {
  const label = (ch: InboxChannel) => `${PLATFORM_LABELS[ch.platform] ?? ch.platform} · ${ch.display_name ?? ch.username ?? ch.id}`;
  const opt = (ch: InboxChannel) => html`<option value="${ch.id}" ${channelId === ch.id ? "selected" : ""}>${label(ch)}</option>`;
  const anyBrand = chans.some((ch) => ch.brand_key);
  if (!anyBrand) return html`${chans.map(opt)}`;
  const byBrand = new Map<string, InboxChannel[]>();
  for (const ch of chans) {
    const k = ch.brand_key ?? "";
    (byBrand.get(k) ?? byBrand.set(k, []).get(k)!).push(ch);
  }
  const keys = [...byBrand.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return html`${keys.map(
    (k) => html`<optgroup label="${k === "" ? "Unassigned" : k}">${byBrand.get(k)!.map(opt)}</optgroup>`,
  )}`;
}

// The thread is a universal, chronological timeline of items from any inbound source. A reaction is a
// small centered note; a comment is the post-anchored event that may have triggered an auto-DM/reply;
// a message is a DM bubble. New channels add item kinds without changing the renderer's shape.
type ThreadItem =
  | { kind: "message"; id: string; direction: string; text: string | null; createdAt: Date }
  | { kind: "reaction"; id: string; emoji: string | null; reactionType: string; createdAt: Date }
  | { kind: "comment"; id: string; text: string; postId: string | null; postUrl: string | null; replyText: string | null; dmSent: boolean; replySent: boolean; dmConvId: string | null; error: string | null; createdAt: Date };

/** A public URL for the post a comment was on, where the platform allows building one from the id.
 *  Instagram media ids don't map to a public URL without the shortcode (which we don't store). */
function postUrlFor(platform: string, postId: string | null): string | null {
  if (!postId) return null;
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(postId)}`;
  if (platform === "facebook") return `https://www.facebook.com/${encodeURIComponent(postId)}`;
  return null;
}

/** The thread timeline. `threadType` shapes the empty-state copy (a comment thread with no follow-up
 *  DM is a normal state, not an error). */
function renderMessages(items: ThreadItem[], threadType: "dm" | "comment" = "dm"): Html {
  if (items.length === 0) {
    return html`<p class="muted">${threadType === "comment"
      ? "This comment thread has no messages yet — reply below to start a DM."
      : "No messages yet — say hello below."}</p>`;
  }
  return html`${items.map((it) => {
    if (it.kind === "reaction") return html`<div class="msg-reaction muted">reacted ${it.emoji ?? it.reactionType}</div>`;
    if (it.kind === "comment") {
      const postRef = it.postId
        ? it.postUrl
          ? html` on post <a href="${it.postUrl}" target="_blank" rel="noopener" class="mono">${it.postId} ↗</a>`
          : html` on post <span class="mono">${it.postId}</span>`
        : "";
      return html`<div class="msg msg-in">
        <div class="bubble" style="border-left:3px solid var(--primary);background:transparent">
          <div class="muted" style="font-size:.7rem;margin-bottom:.15rem">💬 commented${postRef}</div>
          <div>${it.text}</div>
          ${it.replySent && it.replyText
            ? html`<div style="font-size:.78rem;margin-top:.35rem;padding-left:.5rem;border-left:2px solid #16a34a"><span class="muted">↳ public reply sent ✓</span><br/>${it.replyText}</div>`
            : it.replySent
              ? html`<div class="muted" style="font-size:.7rem;margin-top:.2rem">↳ public reply sent ✓</div>`
              : html``}
          ${it.dmSent
            ? html`<div class="muted" style="font-size:.7rem;margin-top:.2rem">↳ auto-DM sent ✓ ${it.dmConvId ? html`· <a href="#" hx-get="/inbox/${it.dmConvId}" hx-target="#thread" hx-swap="innerHTML">open DM thread →</a>` : ""}</div>`
            : html``}
          ${it.error ? html`<div class="muted" style="font-size:.7rem;margin-top:.2rem;color:var(--danger,#e5484d)">↳ ⚠ ${it.error}</div>` : html``}
        </div>
      </div>`;
    }
    return html`<div class="msg ${it.direction === "outbound" ? "msg-out" : "msg-in"}"><div class="bubble">${it.text ?? "(attachment)"}</div></div>`;
  })}`;
}

type ConvControls = { id: string; status: string; thread_type: "dm" | "comment"; thread_ref: string; is_automation_paused: boolean; needs_manual_reply: boolean; assigned_to: string | null; channel: { display_name: string | null; platform: string } };

const STATUS_LABEL: Record<string, string> = { open: "Open", closed: "Closed", snoozed: "Snoozed" };
const STATUS_TIP: Record<string, string> = {
  open: "Active — sitting in your inbox.",
  closed: "Marked done — leaves the inbox until this person messages again.",
  snoozed: "Set aside — comes back to the inbox on their next message.",
};

/** The conversation control bar: a status pill, the close/snooze/reopen action, the automation
 *  pause toggle, attention/assignment indicators — every control carries a tooltip, plus a
 *  collapsible legend, so it's self-explanatory. All wired to PATCH /conversations/:id. */
function renderConvControls(conv: ConvControls): Html {
  const statusBtn = (label: string, status: string, title: string) =>
    html`<button class="btn btn-sm" title="${title}" hx-post="/inbox/${conv.id}/conversation" hx-ext="json-enc" hx-vals='${`{"status":"${status}"}`}' hx-target="#thread" hx-swap="innerHTML">${label}</button>`;
  return html`<div class="thread-controls" style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;font-size:.8rem;margin:.25rem 0">
    <span class="badge" title="${STATUS_TIP[conv.status] ?? ""}">${STATUS_LABEL[conv.status] ?? conv.status}</span>
    ${conv.needs_manual_reply ? html`<span class="badge" style="background:#b91c1c" title="Automation didn't handle this — a human should reply.">⚠ Needs reply</span>` : html``}
    ${conv.is_automation_paused ? html`<span class="badge" style="background:#b45309" title="Auto-replies are off for this person — you reply manually.">⏸ Auto-replies off</span>` : html``}
    ${conv.assigned_to ? html`<span class="muted" title="Assigned to a teammate.">assigned</span>` : html``}
    ${conv.status === "open"
      ? html`${statusBtn("✓ Done", "closed", "Mark done — hides it from the inbox until they message again.")}${statusBtn("⏰ Snooze", "snoozed", "Set aside — it comes back on their next message.")}`
      : statusBtn("↩ Reopen", "open", "Put it back in the active inbox.")}
    <button class="btn btn-sm" title="${conv.is_automation_paused ? "Let the bot auto-reply here again." : "Stop the bot auto-replying to this person — you'll answer manually."}" hx-post="/inbox/${conv.id}/conversation" hx-ext="json-enc" hx-vals='${`{"is_automation_paused":${conv.is_automation_paused ? "false" : "true"}}`}' hx-target="#thread" hx-swap="innerHTML">${conv.is_automation_paused ? "▶ Resume auto-reply" : "⏸ Pause auto-reply"}</button>
    <details style="font-size:.72rem"><summary class="muted" style="cursor:pointer;list-style:none">ⓘ what do these mean?</summary>
      <div class="muted" style="margin-top:.3rem;line-height:1.5">
        <strong>Done</strong> — handled; leaves the inbox until they write again.<br/>
        <strong>Snooze</strong> — set aside; returns on their next message.<br/>
        <strong>Pause auto-reply</strong> — the bot stops answering this person; you reply by hand.<br/>
        <strong>⚠ Needs reply</strong> — automation found no rule for this; waiting on a human.
      </div>
    </details>
  </div>`;
}

function renderThread(
  conv: ConvName & ConvControls,
  messages: ThreadItem[],
  // On a failed send, show the error and keep the operator's typed text instead of clearing it
  // out as if the message went. `canReply` = the manual_reply PRO feature: free can READ the inbox
  // but the human-reply box is locked (rules still auto-reply for free). `upgradeUrl` for the lock.
  opts: { error?: string; draft?: string; canReply?: boolean; upgradeUrl?: string } = {},
): Html {
  const canReply = opts.canReply ?? true;
  return html`<div class="thread-head">${contactName(conv)} <span class="muted">via ${conv.channel.display_name ?? conv.channel.platform}</span></div>
    ${renderConvControls(conv)}
    ${opts.error ? html`<div class="notice notice-err">${opts.error}</div>` : html``}
    <div id="thread-msgs" class="thread-msgs" hx-get="/inbox/${conv.id}/messages" hx-trigger="every 5s" hx-swap="innerHTML">${renderMessages(messages, conv.thread_type)}</div>
    ${canReply
      ? html`<form class="reply-bar" hx-post="/inbox/${conv.id}/reply" hx-ext="json-enc" hx-target="#thread" hx-swap="innerHTML">
          <textarea class="textarea" name="text" rows="2" placeholder="Type a reply..." required>${opts.draft ?? ""}</textarea>
          <button class="btn btn-primary" type="submit">Send</button>
        </form>`
      : html`<div class="reply-bar reply-locked">
          <textarea class="textarea" rows="2" placeholder="Replying by hand is a PRO feature — your rules still auto-reply for free." disabled></textarea>
          <a class="btn btn-primary" href="${opts.upgradeUrl ?? "#"}">Upgrade to reply</a>
        </div>`}`;
}

function loadConversations(workspaceId: string, filter: ConvFilter = "all", channelId = "all") {
  const where: SQL[] = [eq(conversations.workspace_id, workspaceId)];
  if (filter === "needs_reply") where.push(eq(conversations.needs_manual_reply, true));
  else if (filter === "unread") where.push(gt(conversations.unread_count, 0));
  else if (filter === "dm") where.push(eq(conversations.thread_type, "dm"));
  else if (filter === "comment") where.push(eq(conversations.thread_type, "comment"));
  if (channelId !== "all") where.push(eq(conversations.channel_id, channelId));
  return db.query.conversations.findMany({
    where: and(...where),
    orderBy: desc(conversations.last_message_at),
    limit: 50,
    ...CONV_QUERY,
  });
}

/** Channels for the inbox channel-filter dropdown (id + label + brand for grouping). */
function loadInboxChannels(workspaceId: string) {
  return db.query.channels.findMany({
    where: eq(channels.workspace_id, workspaceId),
    orderBy: asc(channels.created_at),
    columns: { id: true, display_name: true, platform: true, username: true, brand_key: true },
  });
}

function loadConversation(id: string, workspaceId: string) {
  return db.query.conversations.findFirst({
    where: and(eq(conversations.id, id), eq(conversations.workspace_id, workspaceId)),
    ...CONV_QUERY,
  });
}

async function loadMessages(conversationId: string): Promise<ThreadItem[]> {
  // The thread's own conversation: gives the platform (for post links) and, for a comment thread,
  // lets us link each comment's auto-DM to the contact's separate DM thread.
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { channel_id: true, contact_id: true, thread_type: true, platform: true },
  });
  let dmSiblingId: string | null = null;
  if (conv && conv.thread_type === "comment") {
    const dm = await db.query.conversations.findFirst({
      where: and(eq(conversations.channel_id, conv.channel_id), eq(conversations.contact_id, conv.contact_id), eq(conversations.thread_type, "dm")),
      columns: { id: true },
    });
    dmSiblingId = dm?.id ?? null;
  }
  const platform = conv?.platform ?? "";

  const [msgs, reactions, comments] = await Promise.all([
    db.query.messages.findMany({
      where: eq(messages.conversation_id, conversationId),
      orderBy: desc(messages.created_at),
      limit: 50,
      columns: { id: true, direction: true, text: true, created_at: true },
    }),
    db.query.messageReactions.findMany({
      where: eq(messageReactions.conversation_id, conversationId),
      orderBy: desc(messageReactions.created_at),
      limit: 50,
      columns: { id: true, emoji: true, reaction_type: true, created_at: true },
    }),
    // Comments that opened/belong to this thread — the event the operator is actually replying to.
    db.query.commentLogs.findMany({
      where: eq(commentLogs.conversation_id, conversationId),
      orderBy: desc(commentLogs.created_at),
      limit: 50,
      columns: { id: true, comment_text: true, post_id: true, reply_text: true, dm_sent: true, reply_sent: true, error: true, created_at: true },
    }),
  ]);
  const items: ThreadItem[] = [
    ...msgs.map((m) => ({ kind: "message" as const, id: m.id, direction: m.direction, text: m.text, createdAt: m.created_at })),
    ...reactions.map((r) => ({ kind: "reaction" as const, id: r.id, emoji: r.emoji, reactionType: r.reaction_type, createdAt: r.created_at })),
    ...comments.map((c) => ({ kind: "comment" as const, id: c.id, text: c.comment_text, postId: c.post_id, postUrl: postUrlFor(platform, c.post_id), replyText: c.reply_text, dmSent: c.dm_sent, replySent: c.reply_sent, dmConvId: dmSiblingId, error: c.error, createdAt: c.created_at })),
  ];
  // Chronological ascending; interleaves comments, reactions and messages by time.
  return items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// ─── channels ─────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", telegram: "Telegram", youtube: "YouTube" };

// Plain-language meaning of each inbound webhook handling status, for the /webhooks legend.
const WEBHOOK_STATUS_LEGEND: ReadonlyArray<readonly [string, Tone, string]> = [
  ["fired", "ok", "Matched an active rule — an auto-reply was sent or queued."],
  ["recorded", "info", "Stored for engagement only (a like/reaction on your post) — no rule runs on these."],
  ["received", "neutral", "Arrived and logged, still being processed (transient)."],
  ["no_match", "neutral", "Valid event, but no rule's keywords/trigger matched."],
  ["paused", "warn", "A rule would match, but it's currently paused."],
  ["ignored", "neutral", "Intentionally skipped — e.g. your own echo or a duplicate."],
  ["unhandled", "neutral", "An event type the app doesn't act on."],
  ["error", "bad", "Processing failed — open the event for details."],
];
const WEBHOOK_STATUS_TONE: Record<string, Tone> = Object.fromEntries(WEBHOOK_STATUS_LEGEND.map(([s, tone]) => [s, tone]));

type WebhookEventDetail = typeof import("@/db/schema").webhookEvents.$inferSelect;

function metaRow(label: string, value: unknown): Html {
  if (value === null || value === undefined || value === "") return html``;
  return html`<div class="meta-row"><dt>${label}</dt><dd>${typeof value === "boolean" ? (value ? "yes" : "no") : String(value)}</dd></div>`;
}

/** Expanded view of one inbound webhook event: what arrived + what (if anything) it triggered + the
 *  full raw payload. Lazy-loaded into #wh-detail so the list stays light. */
function renderWebhookDetail(e: WebhookEventDetail): Html {
  const triggered: Array<[string, string]> = [];
  if (e.conversation_id) triggered.push(["Conversation", e.conversation_id]);
  if (e.message_id) triggered.push(["Message", e.message_id]);
  if (e.comment_log_id) triggered.push(["Comment action", e.comment_log_id]);
  if (e.outbound_delivery_id) triggered.push(["Outbound reply", e.outbound_delivery_id]);
  if (e.contact_id) triggered.push(["Contact", e.contact_id]);
  const rawJson = JSON.stringify(e.raw, null, 2);
  return html`<div class="card" id="wh-detail-card" style="margin:.5rem 0 1rem">
    <div class="row" style="align-items:center;gap:.5rem">
      <strong>${PLATFORM_LABELS[e.object ?? ""] ?? e.object ?? "—"} · ${e.event_type}${e.field ? ` · ${e.field}` : ""}</strong>
      <span class="badge tone-${WEBHOOK_STATUS_TONE[e.handling_status] ?? "neutral"}">${e.handling_status}</span>
      <span class="grow"></span>
      <button class="btn btn-sm" hx-get="/webhooks/clear" hx-target="#wh-detail" hx-swap="innerHTML">Close ✕</button>
    </div>
    <h4 style="margin:.75rem 0 .25rem">What came in</h4>
    <dl class="meta-list">
      ${metaRow("Received", e.received_at.toISOString().replace("T", " ").slice(0, 19))}
      ${metaRow("Handled", e.handled_at ? e.handled_at.toISOString().replace("T", " ").slice(0, 19) : null)}
      ${metaRow("From (sender id)", e.sender_id)}
      ${metaRow("To (recipient id)", e.recipient_id)}
      ${metaRow("Platform message id", e.platform_message_id)}
      ${metaRow("Echo (our own message)", e.is_echo)}
      ${metaRow("Event key", e.event_key)}
    </dl>
    <h4 style="margin:.75rem 0 .25rem">What was triggered</h4>
    ${triggered.length === 0
      ? html`<p class="muted" style="font-size:.85rem">${e.handling_status === "recorded" ? "Nothing — stored for engagement only (no rule runs on post likes/reactions)." : e.handling_status === "fired" ? "A reply was sent/queued (no linked record captured)." : "Nothing was triggered for this event."}</p>`
      : html`<dl class="meta-list">${triggered.map(([k, v]) =>
          k === "Conversation"
            ? html`<div class="meta-row"><dt>${k}</dt><dd><a href="/inbox/${v}">${v} →</a></dd></div>`
            : html`<div class="meta-row"><dt>${k}</dt><dd><code class="mono">${v}</code></dd></div>`,
        )}</dl>`}
    ${e.error_detail ? html`<div class="notice notice-err" style="margin-top:.5rem">${e.error_detail}</div>` : html``}
    <h4 style="margin:.75rem 0 .25rem">Raw payload</h4>
    <pre class="mono" style="max-height:340px;overflow:auto;background:var(--bg);padding:.6rem;border-radius:var(--radius-control);font-size:.72rem;white-space:pre-wrap;word-break:break-word">${rawJson}</pre>
  </div>`;
}

/**
 * The alert-webhook config form (PRO). Custom header VALUES are never echoed back — only their names
 * (so the operator knows what's set without leaking secrets). Headers are entered as `Key: Value`
 * lines; extra payload fields as a JSON object with {{placeholder}} tokens; field selection as a
 * comma list (blank = send all standard fields).
 */
function renderAlertWebhook(cfg: AlertWebhookConfig | null, canConfigure: boolean, upgradeUrl: string, msg?: string): Html {
  const notice = msg ? html`<div class="notice notice-ok">${msg}</div>` : html``;
  if (!canConfigure) {
    return html`${notice}<p class="muted" style="font-size:.85rem">Configuring a proactive alert webhook is ${proLink(upgradeUrl, "PRO")}.</p>`;
  }
  const headerNames = cfg ? Object.keys(cfg.headers) : [];
  const extraJson = cfg && Object.keys(cfg.extraFields).length ? JSON.stringify(cfg.extraFields, null, 2) : "";
  const selection = cfg?.fieldSelection?.join(", ") ?? "";
  return html`${notice}
    <form hx-post="/settings/alert-webhook" hx-ext="json-enc" hx-target="#alert-webhook-area" hx-swap="innerHTML" class="stack">
      <label class="muted" style="font-size:.75rem">Webhook URL</label>
      <input class="input mono" name="url" placeholder="https://hooks.example.com/alert" value="${cfg?.url ?? ""}" required />
      <label style="display:flex;gap:.4rem;align-items:center;font-size:.85rem"><input type="checkbox" name="enabled" value="true" ${cfg ? (cfg.enabled ? "checked" : "") : "checked"} /> Enabled</label>
      <label class="muted" style="font-size:.75rem">Custom headers — one <code>Key: Value</code> per line (encrypted at rest)${headerNames.length ? html` · currently set: <strong>${headerNames.join(", ")}</strong> (re-enter to change)` : html``}</label>
      <textarea class="textarea mono" name="headers" rows="2" placeholder="Authorization: Bearer xxx&#10;X-Api-Key: yyy"></textarea>
      <label class="muted" style="font-size:.75rem">Extra payload fields — JSON, supports {{type}} {{display_name}} {{days_left}} {{detail}} {{expires_at}}</label>
      <textarea class="textarea mono" name="extra" rows="3" placeholder='{ "to": "ops@example.com", "subject": "${BRAND.name}: {{type}} ({{days_left}}d)" }'>${extraJson}</textarea>
      <label class="muted" style="font-size:.75rem">Only send these standard fields (comma list, blank = all)</label>
      <input class="input mono" name="selection" placeholder="type, display_name, detail" value="${selection}" />
      <div class="row" style="gap:.5rem">
        <button class="btn btn-primary" type="submit">Save</button>
        ${cfg ? html`<button class="btn btn-sm" type="button" hx-delete="/settings/alert-webhook" hx-target="#alert-webhook-area" hx-swap="innerHTML" hx-confirm="Remove the alert webhook?">Remove</button>` : html``}
      </div>
    </form>`;
}

/** Parse a `Key: Value` per-line textarea into a header map (ignoring blanks / malformed lines). */
function parseHeaderLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

// ─── registration ─────────────────────────────────────────────────────────────

/**
 * Turn a delegated API response into an error notice (or undefined on success). A swallowed `null`
 * (the delegated call threw) and any >=400 both surface a message — preferring the API's own error
 * text — so a destructive/approval action that failed isn't silently re-rendered as if it worked.
 */
async function noticeFrom(res: Response | null, fallback: string): Promise<string | undefined> {
  if (res && res.status < 400) return undefined;
  if (!res) return fallback;
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export function registerDashboard(app: Hono, sessionGuard: MiddlewareHandler): void {
  // Every dashboard route runs the first-party origin check (a no-op on safe methods) before the
  // session check, so a cross-site write is refused even before auth runs.
  const guard = every(requireSameOrigin, sessionGuard);
  // Overview — the free landing: aggregate counters + an identity-free recent-sends log.
  app.get("/overview", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    const ov = await loadOverview(a.workspaceId);
    // When the publishing wing is entitled, fold its KPIs (attention / upcoming / events) into the
    // unified overview alongside the reply stats (workspace-scoped). Otherwise it's the reply landing.
    const pub = products.has("publishing")
      ? await (async () => {
          const [attention, upcoming, recent] = await Promise.all([
            gatherAttention(a.workspaceId),
            upcomingScheduled(a.workspaceId, 6),
            recentEvents(a.workspaceId, 8),
          ]);
          return { attention, upcoming, recent };
        })()
      : null;
    return c.html(dashboardDoc(t("title.suffix", { section: "Overview" }), "/overview", renderOverview(ov, features, upgradeUrl, pub), features, products));
  });

  // Inbox — READING incoming conversations is free (basic info; rules auto-reply for free). Only the
  // human-reply box is PRO (manual_reply), gated in renderThread + on the send endpoint. The richer
  // contacts CRM (tags/assignment, /contacts) stays PRO (contacts_crm).
  app.get("/inbox", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, products } = await getInstanceLicense();
    const filter = parseConvFilter(c.req.query("filter"));
    const channelId = c.req.query("channel") || "all";
    const [conversations, chans] = await Promise.all([
      loadConversations(a.workspaceId, filter, channelId),
      loadInboxChannels(a.workspaceId),
    ]);
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Inbox" }),
        "/inbox",
        html`<div class="inbox">
          <div id="conv-panel" class="conv-list"
            hx-get="/inbox/list?filter=${filter}&channel=${channelId}"
            hx-trigger="sse:comment from:body, sse:message from:body, sse:reaction from:body"
            hx-swap="innerHTML">${renderConvPanel(conversations, filter, channelId, chans)}</div>
          <div id="thread" class="thread"><div class="thread-empty">Select a conversation</div></div>
        </div>`,
        features,
        products,
      ),
    );
  });

  // htmx: re-render the whole left panel (tabs + channel dropdown + rows) on a filter/channel change.
  app.get("/inbox/list", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const filter = parseConvFilter(c.req.query("filter"));
    const channelId = c.req.query("channel") || "all";
    const [conversations, chans] = await Promise.all([
      loadConversations(a.workspaceId, filter, channelId),
      loadInboxChannels(a.workspaceId),
    ]);
    return c.html(renderConvPanel(conversations, filter, channelId, chans));
  });

  app.get("/inbox/:id", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { features, upgradeUrl } = await getInstanceLicense();
    const id = c.req.param("id");
    const conv = await loadConversation(id, a.workspaceId);
    if (!conv) return c.notFound();
    // workspace_id alongside the PK keeps the unread reset tenant-scoped.
    await db.update(conversations).set({ unread_count: 0 }).where(and(eq(conversations.id, id), eq(conversations.workspace_id, a.workspaceId))).catch(() => {});
    const msgs = await loadMessages(id);
    return c.html(renderThread(conv, msgs, { canReply: features.has("manual_reply"), upgradeUrl }));
  });

  app.get("/inbox/:id/messages", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    const conv = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, id), eq(conversations.workspace_id, a.workspaceId)),
      columns: { id: true, thread_type: true },
    });
    if (!conv) return c.notFound();
    return c.html(renderMessages(await loadMessages(id), conv.thread_type));
  });

  app.post("/inbox/:id/reply", guard, async (c) => {
    const id = c.req.param("id");
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const draft = typeof form.text === "string" ? form.text : "";
    // Inspect the send result instead of swallowing it: a rejected reply (channel needs_reauth,
    // empty/over-long text, no platform identity) must surface an error and keep the draft, not
    // clear the box as if it sent.
    const res = await conversationMessages
      .POST(jsonReq(c, { text: draft }), { params: Promise.resolve({ conversationId: id }) })
      .catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { features, upgradeUrl } = await getInstanceLicense();
    const canReply = features.has("manual_reply");
    const conv = await loadConversation(id, a.workspaceId);
    if (!conv) return c.notFound();
    if (!res || res.status >= 400) {
      const errBody = res ? ((await res.json().catch(() => null)) as { error?: { message?: string } } | null) : null;
      const error = errBody?.error?.message ?? "Could not send the reply. Please try again.";
      return c.html(renderThread(conv, await loadMessages(id), { error, draft, canReply, upgradeUrl }));
    }
    return c.html(renderThread(conv, await loadMessages(id), { canReply, upgradeUrl }));
  });

  // Conversation controls: status (close/snooze/reopen) + automation pause toggle, delegated to the
  // PATCH /conversations/:id API and re-rendering the thread.
  app.post("/inbox/:id/conversation", guard, async (c) => {
    const id = c.req.param("id");
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof form.status === "string") patch.status = form.status;
    if (typeof form.is_automation_paused === "boolean") patch.is_automation_paused = form.is_automation_paused;
    const res = await conversation
      .PATCH(jsonReqMethod(c, "PATCH", patch), { params: Promise.resolve({ conversationId: id }) })
      .catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { features, upgradeUrl } = await getInstanceLicense();
    const conv = await loadConversation(id, a.workspaceId);
    if (!conv) return c.notFound();
    const error = !res || res.status >= 400 ? await noticeFrom(res, "Could not update the conversation.") : undefined;
    return c.html(renderThread(conv, await loadMessages(id), { error, canReply: features.has("manual_reply"), upgradeUrl }));
  });

  // Connect a channel with a pasted long-lived / System User token. On success the unified channels
  // page reloads (HX-Redirect); on failure a small inline error is returned (no list — the list lives
  // on the dedicated /channels page now).
  app.post("/channels/connect-token", guard, async (c) => {
    const res = await channelConnectToken.POST(c.req.raw);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    if (res.status >= 400) {
      const body = await res.json().catch(() => ({}));
      return c.html(html`<div class="auth-error">${body?.error?.message ?? "Could not connect with this token."}</div>`);
    }
    c.header("HX-Redirect", "/channels");
    return c.body(null, 200);
  });

  app.post("/channels/telegram/connect", guard, async (c) => {
    const res = await channelTelegram.POST(c.req.raw);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    if (res.status >= 400) {
      const body = await res.json().catch(() => ({}));
      return c.html(html`<div class="auth-error">${body?.error?.message ?? "Could not connect the Telegram bot."}</div>`);
    }
    c.header("HX-Redirect", "/channels");
    return c.body(null, 200);
  });

  // Contacts — the customer CRM; seeing individual people is PRO.
  app.get("/contacts", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    if (!features.has("contacts_crm")) {
      return c.html(
        dashboardDoc(t("title.suffix", { section: "Contacts" }), "/contacts", proLockMain("Contacts", html`The contacts CRM is a PRO feature.`, upgradeUrl), features, products),
      );
    }
    const chans = await loadInboxChannels(a.workspaceId);
    const platforms = [...new Set(chans.map((ch) => ch.platform))];
    // Brand filter — only when the license allows multiple brands and the workspace actually has some.
    const brandList = features.has("multi_brand") ? await listBrands(a.workspaceId) : [];
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Contacts" }),
        "/contacts",
        html`<div class="page" style="max-width:900px">
          <h1>Contacts</h1>
          <p class="muted">Everyone who has messaged your connected pages. Contacts are assigned to a channel automatically.</p>
          <form class="row" style="gap:.5rem;margin:1rem 0;flex-wrap:wrap;align-items:center">
            <input class="input" style="max-width:340px" type="search" name="q" placeholder="Search by name, email, username..."
              hx-get="/contacts/list" hx-trigger="keyup changed delay:300ms, search" hx-target="#contacts-list" hx-swap="innerHTML" hx-include="closest form" />
            ${brandList.length > 0
              ? html`<select class="input" name="brand" style="max-width:200px;font-size:.85rem" hx-get="/contacts/list" hx-trigger="change" hx-target="#contacts-list" hx-swap="innerHTML" hx-include="closest form">
                  <option value="all">All brands</option>
                  ${brandList.map((b) => html`<option value="${b.key}">${b.name}</option>`)}
                </select>`
              : html``}
            ${chans.length > 1
              ? html`<select class="input" name="channel" style="max-width:220px;font-size:.85rem" hx-get="/contacts/list" hx-trigger="change" hx-target="#contacts-list" hx-swap="innerHTML" hx-include="closest form">
                  <option value="all">All channels</option>
                  ${chans.map((ch) => html`<option value="${ch.id}">${PLATFORM_LABELS[ch.platform] ?? ch.platform} · ${ch.display_name ?? ch.username ?? ch.id}</option>`)}
                </select>`
              : html``}
            ${platforms.length > 1
              ? html`<select class="input" name="platform" style="max-width:160px;font-size:.85rem" hx-get="/contacts/list" hx-trigger="change" hx-target="#contacts-list" hx-swap="innerHTML" hx-include="closest form">
                  <option value="all">All platforms</option>
                  ${platforms.map((p) => html`<option value="${p}">${PLATFORM_LABELS[p] ?? p}</option>`)}
                </select>`
              : html``}
          </form>
          <div id="contacts-list">${renderContacts(await loadContacts(a.workspaceId, ""))}</div>
        </div>`,
        features,
        products,
      ),
    );
  });

  // Engagement — post reactions/likes; the customer-engagement surface is PRO.
  app.get("/engagement", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    if (!features.has("contacts_crm")) {
      return c.html(
        dashboardDoc(t("title.suffix", { section: "Engagement" }), "/engagement", proLockMain("Engagement", html`Seeing who reacted to your posts is a PRO feature.`, upgradeUrl), features, products),
      );
    }
    const [posts, dms] = await Promise.all([loadEngagement(a.workspaceId), loadMessageReactions(a.workspaceId)]);
    return c.html(dashboardDoc(t("title.suffix", { section: "Engagement" }), "/engagement", renderEngagement(posts, dms), features, products));
  });

  app.get("/contacts/list", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { features } = await getInstanceLicense();
    if (!features.has("contacts_crm")) return c.body(null, 402);
    const q = c.req.query("q") ?? "";
    const channelId = c.req.query("channel") || "all";
    const platform = c.req.query("platform") || "all";
    // The brand dimension is a multi_brand (PRO) capability; ignore it on instances without the feature.
    const brand = features.has("multi_brand") ? (c.req.query("brand") || "all") : "all";
    // "Load more" grows the page (capped) so a workspace with >50 contacts is browsable.
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 50), 1000);
    return c.html(renderContacts(await loadContacts(a.workspaceId, q, limit, channelId, platform, brand), q, limit, channelId, platform, brand));
  });

  // Settings
  app.post("/settings/alert-webhook", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const license = await getInstanceLicense();
    const canAlerts = license.features.has("managed_connection");
    if (!canAlerts) return c.html(renderAlertWebhook(null, false, license.upgradeUrl));

    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const url = typeof form.url === "string" ? form.url.trim() : "";
    if (!/^https?:\/\//.test(url)) {
      return c.html(renderAlertWebhook(await getAlertWebhook(a.workspaceId), true, license.upgradeUrl, "Enter a valid http(s) URL — nothing saved."));
    }
    let extraFields: Record<string, unknown> = {};
    if (typeof form.extra === "string" && form.extra.trim()) {
      try {
        const parsed = JSON.parse(form.extra);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraFields = parsed as Record<string, unknown>;
      } catch {
        return c.html(renderAlertWebhook(await getAlertWebhook(a.workspaceId), true, license.upgradeUrl, "Extra fields must be valid JSON — nothing saved."));
      }
    }
    const headerLines = typeof form.headers === "string" ? parseHeaderLines(form.headers) : {};
    const selection = typeof form.selection === "string" && form.selection.trim()
      ? form.selection.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    // Preserve previously-saved headers when the textarea is left blank (values are never echoed back).
    const existing = await getAlertWebhook(a.workspaceId);
    const headers = Object.keys(headerLines).length ? headerLines : existing?.headers;

    await upsertAlertWebhook(a.workspaceId, {
      url,
      enabled: form.enabled === "true" || form.enabled === true,
      headers,
      extraFields,
      fieldSelection: selection,
    });
    return c.html(renderAlertWebhook(await getAlertWebhook(a.workspaceId), true, license.upgradeUrl, "Alert webhook saved."));
  });

  app.delete("/settings/alert-webhook", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const license = await getInstanceLicense();
    await deleteAlertWebhook(a.workspaceId);
    return c.html(renderAlertWebhook(null, license.features.has("managed_connection"), license.upgradeUrl, "Alert webhook removed."));
  });

  app.get("/settings", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const [workspace, license, alertWebhook] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, a.workspaceId), columns: { message_retention_days: true } }),
      getInstanceLicense(),
      getAlertWebhook(a.workspaceId),
    ]);
    const canAlerts = license.features.has("managed_connection");
    const upgradeUrl = license.upgradeUrl;
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Settings" }),
        "/settings",
        html`<div class="page">
          <h1>Settings</h1>
          <p class="muted">Manage your workspace settings and API access.</p>
          <section class="section">
            <h2>API Keys</h2>
            <p class="muted">Programmatic API access now lives on its own page. <a href="/api-keys">Open API Keys →</a></p>
          </section>
          <section class="section">
            <h2>Data retention</h2>
            <p class="muted" style="margin-bottom:1rem">Delete messages older than N days (runs daily). Blank = keep forever. Pending messages are never deleted.</p>
            <form hx-post="/settings/retention" hx-ext="json-enc" hx-target="#retention-msg" hx-swap="innerHTML" class="row">
              <input class="input" style="width:140px" type="number" min="1" name="message_retention_days" placeholder="Keep forever"
                value="${workspace?.message_retention_days ?? ""}" />
              <span class="muted">days</span>
              <button class="btn btn-primary" type="submit">Save</button>
            </form>
            <p id="retention-msg" class="muted" style="margin-top:.5rem"></p>
          </section>
          <section class="section">
            <h2>License</h2>
            <p class="muted" style="margin-bottom:1rem">Unlock PRO features with a license token from Sellf. A free instance keeps all free features.</p>
            <form hx-post="/settings/license" hx-ext="json-enc" hx-target="#license-area" hx-swap="innerHTML" class="stack" style="margin-bottom:1rem">
              <textarea class="input mono" name="token" rows="3" placeholder="Paste your license token" style="font-size:.8rem"></textarea>
              <div class="row"><button class="btn btn-primary" type="submit">Verify &amp; save</button></div>
            </form>
            <div id="license-area">${renderLicense(license)}</div>
          </section>
          <section class="section">
            <h2>Meta App configuration</h2>
            <p class="muted" style="margin-bottom:.75rem">Paste these into your Facebook app at <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a>. They are derived from <code>APP_URL</code> — no guessing.</p>
            ${metaConfigRow("Valid OAuth Redirect URI (Facebook Login → Settings)", `${env.APP_URL}/api/oauth/facebook/callback`)}
            ${metaConfigRow("Valid OAuth Redirect URI (Instagram)", `${env.APP_URL}/api/oauth/instagram/callback`)}
            ${metaConfigRow("Authorized redirect URI — YouTube (Google Cloud Console)", `${env.APP_URL}/api/oauth/youtube/callback`)}
            ${metaConfigRow("Webhook callback URL (Messenger + Instagram products)", `${env.APP_URL}/api/webhooks/meta`)}
            ${metaConfigRow("Webhook verify token", env.META_WEBHOOK_VERIFY_TOKEN || "— set META_WEBHOOK_VERIFY_TOKEN in your env —")}
            ${metaConfigRow("App ID", env.META_APP_ID || "— set META_APP_ID in your env —")}
          </section>
          ${license.products.has("publishing") ? renderProvidersStatus() : ""}
          <section class="section">
            <div class="row" style="align-items:center;gap:.5rem;margin-bottom:.25rem">
              <h2 style="margin:0">Alert webhook</h2>
              ${canAlerts ? html`` : proLink(upgradeUrl, "PRO")}
            </div>
            <p class="muted" style="margin-bottom:1rem">Get a proactive POST when a connection needs re-auth or nears expiry. Add custom headers + templated fields to target email (via your own sender), Slack, or n8n. ${canAlerts ? "" : html`This is a ${proLink(upgradeUrl, "PRO")} feature.`}</p>
            <div id="alert-webhook-area">${renderAlertWebhook(alertWebhook, canAlerts, upgradeUrl)}</div>
          </section>
        </div>`,
        license.features,
        license.products,
      ),
    );
  });

  app.post("/settings/api-keys", guard, async (c) => {
    // Transform the form (name + the scope checkboxes serialized to scopes_json) into the API's
    // JSON shape, so a dashboard key can be scoped instead of always full-access.
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const scopes = parseJsonArray(typeof form.scopes_json === "string" ? form.scopes_json : "").filter((s): s is string => typeof s === "string");
    // An empty scopes array is the "full access" sentinel for programmatic keys (hasScope), but in
    // THIS form every checkbox starts checked, so deselecting them all means the user wants a
    // RESTRICTED key — minting full access would invert that intent. Require at least one.
    if (scopes.length === 0) {
      const a = await auth(c);
      if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
      return c.html(renderKeys(await loadKeys(a.workspaceId), "Select at least one scope (leaving every box checked grants full access)."));
    }
    const res = await apiKeys.POST(jsonReq(c, { name: form.name ?? "", scopes }));
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const body = await res.json().catch(() => ({}));
    const keys = await loadKeys(a.workspaceId);
    const created = res.status === 201 ? body?.data?.key : null;
    const banner = created
      ? html`<div class="notice notice-ok"><strong>Copy this key now — it won't be shown again:</strong><br /><code class="mono">${created}</code></div>`
      : res.status >= 400
        ? html`<div class="notice notice-err">${body?.error?.message ?? "Failed to create key."}</div>`
        : html``;
    return c.html(html`${banner}${renderKeys(keys)}`);
  });

  app.delete("/settings/api-keys/:id", guard, async (c) => {
    const id = c.req.param("id");
    const res = await apiKey.DELETE(c.req.raw, { params: Promise.resolve({ keyId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const keys = await loadKeys(a.workspaceId);
    return c.html(renderKeys(keys, await noticeFrom(res, "Could not revoke the API key.")));
  });

  app.post("/settings/retention", guard, async (c) => {
    const form = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const rawDays = (form as Record<string, unknown>).message_retention_days;
    const days = rawDays === "" || rawDays == null ? null : Number(rawDays);
    // Validate server-side: the input's min="1" is client-only. A direct POST with 0/negative
    // makes the prune cutoff `now` (or the future) and the next retention run deletes EVERY
    // prunable message in the workspace. Require a whole number in a sane range.
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS)) {
      return c.html(html`Retention must be a whole number of days between 1 and ${MAX_RETENTION_DAYS}.`);
    }
    const res = await workspacePatch(c, days);
    return c.html(html`${res ? "Saved." : "Could not save retention policy."}`);
  });

  app.post("/settings/license", guard, async (c) => {
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

  app.post("/settings/license/clear", guard, async (c) => {
    return c.html(renderLicense(await clearLicense(), "License removed.", true));
  });

  // Rules
  app.get("/rules", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    const canFollowGate = features.has("follow_gate");
    const canInteractive = features.has("interactive_messages");
    const canPersonalize = features.has("personalization");
    const canReactionTrigger = features.has("reaction_trigger");
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Rules" }),
        "/rules",
        html`<div class="page">
          <h1>Rules</h1>
          <p class="muted">Auto-replies for DMs and comments. Leave keywords blank on a comment rule with a post to reply to every comment on that post.</p>
          <details class="card" style="margin:1rem 0">
            <summary style="cursor:pointer;font-weight:600">+ New rule</summary>
            <form hx-post="/rules" hx-ext="json-enc" hx-target="#rules-list" hx-swap="innerHTML" class="stack" style="margin-top:.75rem"
              x-data="{
                quickReplies: [],
                buttons: [],
                requiresApproval: false,
                triggerType: 'keyword',
                responseMode: 'text',
                qrJson() {
                  return JSON.stringify(this.quickReplies
                    .filter(q => q.content_type !== 'text' || (q.title && q.title.trim()))
                    .map(q => q.content_type === 'text'
                      ? { content_type: 'text', title: q.title.trim(), payload: (q.payload && q.payload.trim()) ? q.payload.trim() : q.title.trim() }
                      : { content_type: q.content_type }));
                },
                btnJson() {
                  return JSON.stringify(this.buttons
                    .filter(b => b.title && b.title.trim() && b.value && b.value.trim())
                    .map(b => b.kind === 'url' ? { title: b.title.trim(), url: b.value.trim() } : { title: b.title.trim(), payload: b.value.trim() }));
                }
              }">
              <div><label class="label">Name</label><input class="input" name="name" required /></div>
              <div><label class="label">Trigger</label>
                <select class="input" name="trigger_type" x-model="triggerType">
                  <option value="keyword">DM keyword</option>
                  <option value="comment_keyword">Comment keyword</option>
                  <option value="postback">Button tap (postback)</option>
                  ${canReactionTrigger
                    ? html`<option value="reaction">Message reaction</option>`
                    : html`<option value="reaction" disabled>🔒 Message reaction (PRO)</option>`}
                </select>
              </div>
              <div x-show="triggerType !== 'postback' && triggerType !== 'reaction'"><label class="label">Keywords (comma-separated)</label><input class="input" name="keywords" placeholder="hello, hi, info" /></div>
              <div x-show="triggerType === 'reaction'"><p class="muted" style="font-size:.78rem">Fires when someone reacts to one of your messages — sends the reply below as a DM.</p></div>
              <div x-show="triggerType === 'postback'"><label class="label">Button payload (must match the payload of the button you sent)</label><input class="input" name="payload" placeholder="CLAIM_LM" /></div>
              <div x-show="triggerType === 'comment_keyword'"><label class="label">Post ID (blank = any post)</label><input class="input" name="post_id" placeholder="leave blank for any post" /></div>
              <div x-show="triggerType === 'comment_keyword' && responseMode === 'text'"><label class="label">Reply via</label>
                <select class="input" name="reply_mode">
                  <option value="dm">DM only</option>
                  <option value="comment">Public comment only</option>
                  <option value="both">Both</option>
                </select>
              </div>

              <div><label class="label">Response</label>
                <select class="input" name="response_mode" x-model="responseMode">
                  <option value="text">Text reply (with optional buttons / quick replies)</option>
                  ${canFollowGate
                    ? html`<option value="follow_gate">Follow-gate (unlock only after they follow)</option>`
                    : html`<option value="follow_gate" disabled>🔒 Follow-gate (PRO)</option>`}
                </select>
              </div>

              <!-- Follow-gate branches -->
              <div x-show="responseMode === 'follow_gate'" class="stack">
                <p class="muted" style="font-size:.75rem">Use with a Button-tap trigger. On each tap we check if they follow you, then send one of these. Instagram only.</p>
                <div><label class="label">When they follow — final message (e.g. your resource link)</label><textarea class="textarea" name="followed_text" rows="2"></textarea></div>
                <div><label class="label">When they don't follow yet — re-prompt message</label><textarea class="textarea" name="not_followed_text" rows="2" placeholder="Follow us first, then tap again 🙏"></textarea></div>
                <div><label class="label">Re-prompt button label</label><input class="input" name="claim_label" maxlength="20" placeholder="Chcę odebrać" /></div>
              </div>

              <div x-show="responseMode === 'text'"><label class="label">Reply text (DM / fallback)</label><textarea class="textarea" name="text" rows="2"></textarea>
                <p class="muted" style="font-size:.72rem;margin-top:.25rem">${canPersonalize
                  ? html`Personalization: <code>{imie}</code> = first name, <code>{name}</code> = full name.`
                  : html`Personalization (<code>{imie}</code>/<code>{name}</code>) — ${proLink(upgradeUrl)}`}</p>
              </div>
              <div x-show="responseMode === 'text' && triggerType === 'comment_keyword'"><label class="label">Public comment reply text (optional)</label><input class="input" name="comment_reply_text" /></div>

              ${canInteractive
                ? html`<div x-show="responseMode === 'text'">
                <label class="label">Quick replies (tappable chips above the text box · max 13)</label>
                <template x-for="(q, i) in quickReplies" :key="i">
                  <div style="display:flex;gap:.4rem;margin-bottom:.4rem">
                    <select class="input" x-model="q.content_type" style="max-width:150px">
                      <option value="text">Text</option>
                      <option value="user_email">Ask email</option>
                      <option value="user_phone_number">Ask phone</option>
                    </select>
                    <input class="input" placeholder="Label (≤20)" maxlength="20" x-model="q.title" x-show="q.content_type === 'text'" />
                    <input class="input" placeholder="Payload (tap value)" x-model="q.payload" x-show="q.content_type === 'text'" />
                    <button class="btn btn-sm btn-danger" type="button" @click="quickReplies.splice(i, 1)">×</button>
                  </div>
                </template>
                <button class="btn btn-sm" type="button" @click="quickReplies.push({ content_type: 'text', title: '', payload: '' })" x-show="quickReplies.length < 13">+ quick reply</button>
              </div>

              <div x-show="responseMode === 'text'">
                <label class="label">Buttons (shown inside the message · max 3)</label>
                <template x-for="(b, i) in buttons" :key="i">
                  <div style="display:flex;gap:.4rem;margin-bottom:.4rem">
                    <input class="input" placeholder="Label (≤20)" maxlength="20" x-model="b.title" />
                    <select class="input" x-model="b.kind" style="max-width:170px">
                      <option value="postback">Reply (postback)</option>
                      <option value="url">Open link</option>
                    </select>
                    <input class="input" :placeholder="b.kind === 'url' ? 'https://…' : 'PAYLOAD'" x-model="b.value" />
                    <button class="btn btn-sm btn-danger" type="button" @click="buttons.splice(i, 1)">×</button>
                  </div>
                </template>
                <button class="btn btn-sm" type="button" @click="buttons.push({ title: '', kind: 'postback', value: '' })" x-show="buttons.length < 3">+ button</button>
                <p class="muted" style="font-size:.7rem;margin-top:.25rem">Instagram supports postback + link buttons; quick-reply icons and extra button types are Messenger-only.</p>
              </div>`
                : html`<div x-show="responseMode === 'text'" class="card" style="font-size:.78rem"><span class="muted">Buttons &amp; quick replies are a PRO feature.</span> ${proLink(upgradeUrl, "Upgrade")}</div>`}

              <label style="display:flex;align-items:center;gap:.5rem;font-size:.875rem;cursor:pointer">
                <input type="checkbox" x-model="requiresApproval" />
                Hold for human approval before sending (review in Approvals)
              </label>

              <input type="hidden" name="quick_replies_json" :value="qrJson()" />
              <input type="hidden" name="buttons_json" :value="btnJson()" />
              <input type="hidden" name="requires_approval" :value="requiresApproval" />
              <button class="btn btn-primary" type="submit" style="align-self:flex-start">Create rule</button>
            </form>
          </details>
          <div id="rules-list">${renderRules(await loadRules(a.workspaceId))}</div>
        </div>`,
        features,
        products,
      ),
    );
  });

  app.post("/rules", guard, async (c) => {
    const form = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const keywords = (form.keywords ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map((value) => ({ value, match_type: "contains" }));
    const triggerType = ["comment_keyword", "postback", "reaction"].includes(form.trigger_type) ? form.trigger_type : "keyword";
    const postId = (form.post_id ?? "").trim();
    // The postback payload input is hidden (x-show) for other triggers but json-enc still serializes
    // it, so a value typed under "postback" then switched away would leak in as a stale payload (and
    // into the follow-gate claim button below). Only honour it when the trigger is actually postback.
    const payloadValue = triggerType === "postback" ? (form.payload ?? "").trim() : "";
    const commentReply = (form.comment_reply_text ?? "").trim();
    const followGate = form.response_mode === "follow_gate";

    const triggerConfig: Record<string, unknown> = {};
    if (triggerType === "postback") {
      if (payloadValue) triggerConfig.payload = payloadValue;
    } else if (triggerType === "reaction") {
      // Empty config = fire on any reaction. Keywords/post_id don't apply here.
    } else {
      if (keywords.length) triggerConfig.keywords = keywords;
      if (triggerType === "comment_keyword" && postId) triggerConfig.post_id = postId;
    }

    let responseType = "text";
    const responseConfig: Record<string, unknown> = {};
    if (followGate) {
      responseType = "follow_gate";
      const claimLabel = (form.claim_label ?? "").trim() || "Chcę odebrać";
      const claimPayload = payloadValue || "CLAIM";
      responseConfig.followed = { text: form.followed_text ?? "" };
      responseConfig.not_followed = { text: form.not_followed_text ?? "", buttons: [{ title: claimLabel, payload: claimPayload }] };
    } else {
      responseConfig.text = form.text ?? "";
      if (triggerType === "comment_keyword") {
        responseConfig.reply_mode = form.reply_mode === "comment" || form.reply_mode === "both" ? form.reply_mode : "dm";
        if (commentReply) responseConfig.comment_reply_text = commentReply;
      }
      const quickReplies = parseJsonArray(form.quick_replies_json);
      if (quickReplies.length) responseConfig.quick_replies = quickReplies;
      const buttons = parseJsonArray(form.buttons_json);
      if (buttons.length) responseConfig.buttons = buttons;
    }

    const payload = {
      name: form.name ?? "",
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      response_type: responseType,
      response_config: responseConfig,
      requires_approval: form.requires_approval === "true",
    };
    const res = await rules.POST(jsonReq(c, payload));
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const list = renderRules(await loadRules(a.workspaceId));
    if (res.status >= 400) {
      const body = await res.json().catch(() => ({}));
      return c.html(html`<div class="notice notice-err">${body?.error?.message ?? "Could not create rule."}</div>${list}`);
    }
    return c.html(list);
  });

  app.post("/rules/:id/toggle", guard, async (c) => {
    const id = c.req.param("id");
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const existing = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.id, id), eq(autoReplyRules.workspace_id, a.workspaceId)), columns: { is_active: true } });
    let res: Response | null = null;
    if (existing) {
      res = await rule.PATCH(jsonReqMethod(c, "PATCH", { is_active: !existing.is_active }), { params: Promise.resolve({ ruleId: id }) }).catch(() => null);
    }
    return c.html(renderRules(await loadRules(a.workspaceId), await noticeFrom(res, "Could not update the rule.")));
  });

  app.delete("/rules/:id", guard, async (c) => {
    const id = c.req.param("id");
    const res = await rule.DELETE(c.req.raw, { params: Promise.resolve({ ruleId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderRules(await loadRules(a.workspaceId), await noticeFrom(res, "Could not delete the rule.")));
  });

  // The rules list as a partial (for Cancel out of the inline edit form).
  app.get("/rules/list", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderRules(await loadRules(a.workspaceId)));
  });

  app.get("/rules/:id/edit", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const r = await loadRuleForEdit(a.workspaceId, c.req.param("id"));
    if (!r) return c.html(renderRules(await loadRules(a.workspaceId), "Rule not found."));
    return c.html(renderRuleEditForm(r));
  });

  app.post("/rules/:id", guard, async (c) => {
    const id = c.req.param("id");
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const form = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const existing = await loadRuleForEdit(a.workspaceId, id);
    if (!existing) return c.html(renderRules(await loadRules(a.workspaceId), "Rule not found."));
    // The API PATCH replaces whole config columns, so overlay the edited fields onto the existing
    // configs — advanced response config (buttons / quick replies / follow-gate) survives untouched.
    const triggerConfig = { ...((existing.trigger_config ?? {}) as Record<string, unknown>) };
    if (existing.trigger_type === "keyword" || existing.trigger_type === "comment_keyword") {
      const keywords = (form.keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean).map((value) => ({ value, match_type: "contains" }));
      if (keywords.length) triggerConfig.keywords = keywords;
      else delete triggerConfig.keywords;
    }
    if (existing.trigger_type === "comment_keyword") {
      const postId = (form.post_id ?? "").trim();
      if (postId) triggerConfig.post_id = postId;
      else delete triggerConfig.post_id;
    }
    const responseConfig = { ...((existing.response_config ?? {}) as Record<string, unknown>) };
    if (existing.response_type === "text") {
      responseConfig.text = form.text ?? "";
      if (existing.trigger_type === "comment_keyword") {
        responseConfig.reply_mode = form.reply_mode === "comment" || form.reply_mode === "both" ? form.reply_mode : "dm";
        const cr = (form.comment_reply_text ?? "").trim();
        if (cr) responseConfig.comment_reply_text = cr;
        else delete responseConfig.comment_reply_text;
      }
    }
    const payload = {
      name: form.name ?? "",
      trigger_config: triggerConfig,
      response_config: responseConfig,
      requires_approval: form.requires_approval === "true",
    };
    const res = await rule.PATCH(jsonReqMethod(c, "PATCH", payload), { params: Promise.resolve({ ruleId: id }) }).catch(() => null);
    const list = renderRules(await loadRules(a.workspaceId));
    if (!res || res.status >= 400) {
      const body = res ? await res.json().catch(() => ({})) : {};
      return c.html(html`<div class="notice notice-err">${(body as { error?: { message?: string } })?.error?.message ?? "Could not update the rule."}</div>${list}`);
    }
    return c.html(list);
  });

  // Approvals (human-in-the-loop review queue)
  app.get("/approvals", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, products } = await getInstanceLicense();
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Approvals" }),
        "/approvals",
        html`<div class="page">
          <h1>Approvals</h1>
          <p class="muted">Replies from rules marked “hold for approval” wait here. Approve to send, or reject to discard.</p>
          <div id="approvals-list">${renderApprovals(await loadApprovals(a.workspaceId))}</div>
        </div>`,
        features,
        products,
      ),
    );
  });

  app.post("/approvals/:id/approve", guard, async (c) => {
    const id = c.req.param("id");
    const res = await approvalApprove.POST(jsonReq(c, {}), { params: Promise.resolve({ approvalId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    // Most impactful swallow: if the enqueue tx failed the approval stays pending and nothing was
    // sent — the operator must see that, not a silent re-render.
    return c.html(renderApprovals(await loadApprovals(a.workspaceId), await noticeFrom(res, "Could not approve — the reply was not sent.")));
  });

  app.post("/approvals/:id/reject", guard, async (c) => {
    const id = c.req.param("id");
    const res = await approvalReject.POST(jsonReq(c, {}), { params: Promise.resolve({ approvalId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderApprovals(await loadApprovals(a.workspaceId), await noticeFrom(res, "Could not reject the reply.")));
  });

  // Events — the workspace activity log (a nav target). Read-only, identity-free type/time rows.
  app.get("/events", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, products } = await getInstanceLicense();
    const rows = await db.query.events.findMany({
      where: eq(eventsTbl.workspace_id, a.workspaceId),
      orderBy: [desc(eventsTbl.created_at)],
      limit: 100,
      columns: { id: true, type: true, subject_type: true, subject_id: true, created_at: true },
    });
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Events" }),
        "/events",
        html`<div class="page">
          <h1>Events</h1>
          <p class="muted">A log of what happened in this workspace — channel, publishing and automation events.</p>
          ${rows.length === 0
            ? html`<p class="muted">No events yet. Activity shows up here as channels connect and automations run.</p>`
            : html`<table><thead><tr><th>Type</th><th>Subject</th><th>When</th></tr></thead>
                <tbody>${rows.map(
                  (e) => html`<tr>
                    <td><span class="badge">${e.type}</span></td>
                    <td class="muted" style="font-size:.8rem">${e.subject_type ? `${e.subject_type}${e.subject_id ? ` · ${e.subject_id}` : ""}` : "—"}</td>
                    <td class="muted">${timeAgo(e.created_at)}</td>
                  </tr>`,
                )}</tbody></table>`}
        </div>`,
        features,
        products,
      ),
    );
  });

  // Webhooks — the inbound webhook-event log (a nav target). Shows recent Meta/Telegram deliveries and
  // how each was handled; outbound alert-webhook config lives under Settings.
  app.get("/webhooks", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, products, upgradeUrl } = await getInstanceLicense();
    // webhook_events has no workspace_id column (it resolves page→channel); scope by the workspace's
    // own channels so the log is tenant-correct.
    const wsChannels = await db.query.channels.findMany({
      where: eq(channels.workspace_id, a.workspaceId),
      columns: { id: true },
    });
    const channelIds = wsChannels.map((ch) => ch.id);
    const [rows, alertWebhook] = await Promise.all([
      channelIds.length
        ? db.query.webhookEvents.findMany({
            where: inArray(webhookEvents.channel_id, channelIds),
            orderBy: [desc(webhookEvents.received_at)],
            limit: 100,
            columns: { id: true, platform: true, event_type: true, field: true, handling_status: true, received_at: true, error_detail: true },
          })
        : Promise.resolve([]),
      getAlertWebhook(a.workspaceId),
    ]);
    const canAlerts = features.has("managed_connection");
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Webhooks" }),
        "/webhooks",
        html`<div class="page">
          <h1>Webhooks</h1>
          <p class="muted">Two separate things share this name: events <strong>coming in</strong> from the platforms, and an alert we send <strong>out</strong> to you.</p>

          <h2 style="margin-top:1rem">⬇ Incoming — from Meta / Telegram</h2>
          <p class="muted" style="font-size:.85rem">The platforms POST here whenever someone messages, comments, or reacts. This is the log of what arrived and what the bot did with it.</p>
          <div class="card" style="margin:.75rem 0">
            <div class="muted" style="font-size:.8rem;margin-bottom:.2rem">Your inbound webhook URL (paste into your Meta app)</div>
            <code class="mono">${env.APP_URL}/api/webhooks/meta</code>
          </div>
          <details class="card" style="font-size:.82rem;margin-bottom:.75rem">
            <summary style="cursor:pointer;font-weight:600">What do the statuses mean?</summary>
            <dl class="wh-legend" style="margin:.5rem 0 0;display:grid;grid-template-columns:auto 1fr;gap:.35rem .75rem">
              ${WEBHOOK_STATUS_LEGEND.map(([status, tone, desc]) => html`<dt><span class="badge tone-${tone}">${status}</span></dt><dd class="muted">${desc}</dd>`)}
            </dl>
          </details>
          <div id="wh-detail"></div>
          ${rows.length === 0
            ? html`<p class="muted">No webhook events received yet. They appear here once your connected pages send activity.</p>`
            : html`<table><thead><tr><th>Platform</th><th>Event</th><th>Status</th><th>Detail</th><th>When</th><th></th></tr></thead>
                <tbody>${rows.map(
                  (e) => html`<tr>
                    <td>${PLATFORM_LABELS[e.platform ?? ""] ?? e.platform ?? "—"}</td>
                    <td class="muted" style="font-size:.8rem">${e.event_type}${e.field ? ` · ${e.field}` : ""}</td>
                    <td><span class="badge tone-${WEBHOOK_STATUS_TONE[e.handling_status] ?? "neutral"}">${e.handling_status}</span></td>
                    <td class="muted" style="font-size:.78rem">${e.handling_status === "error" && e.error_detail ? html`<span style="color:var(--bad-text)">${e.error_detail}</span>` : e.field ? e.field : "—"}</td>
                    <td class="muted">${timeAgo(e.received_at)}</td>
                    <td><button class="btn btn-sm" hx-get="/webhooks/${e.id}" hx-target="#wh-detail" hx-swap="innerHTML" title="Full payload + what it triggered">View</button></td>
                  </tr>`,
                )}</tbody></table>`}

          <h2 style="margin-top:1.5rem">⬆ Outgoing — alert webhook ${canAlerts ? "" : proLink(upgradeUrl, "PRO")}</h2>
          <p class="muted" style="font-size:.85rem">A proactive POST we send to <em>your</em> endpoint (Slack, n8n, email relay…) when a connection needs re-auth or nears expiry — so you find out before publishing breaks.</p>
          ${!canAlerts
            ? html`<div class="card"><p class="muted" style="font-size:.85rem">Configuring an outbound alert webhook is a ${proLink(upgradeUrl, "PRO")} feature.</p></div>`
            : alertWebhook
              ? html`<div class="card">
                  <div class="row" style="align-items:center;gap:.5rem">
                    <span class="badge tone-${alertWebhook.enabled ? "ok" : "neutral"}">${alertWebhook.enabled ? "Enabled" : "Disabled"}</span>
                    <code class="mono grow" style="overflow-x:auto;white-space:nowrap">${alertWebhook.url}</code>
                  </div>
                  <p class="muted" style="font-size:.78rem;margin-top:.4rem">
                    ${Object.keys(alertWebhook.headers).length ? `${Object.keys(alertWebhook.headers).length} custom header(s) · ` : ""}${Object.keys(alertWebhook.extraFields).length ? `${Object.keys(alertWebhook.extraFields).length} extra field(s) · ` : ""}<a href="/settings#alert">Edit in Settings →</a>
                  </p>
                </div>`
              : html`<div class="card"><p class="muted" style="font-size:.85rem">Not configured yet. <a href="/settings#alert">Set it up in Settings →</a></p></div>`}
        </div>`,
        features,
        products,
      ),
    );
  });

  // Clear the inbound-event detail panel (Close button).
  app.get("/webhooks/clear", guard, (c) => c.html(html``));

  // Full detail for one inbound webhook event — raw payload + what it triggered. Tenant-scoped: the
  // event must belong to one of this workspace's channels (webhook_events has no workspace_id).
  app.get("/webhooks/:id", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const ev = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.id, c.req.param("id")) });
    if (!ev || !ev.channel_id) return c.html(html`<div class="notice notice-err">Event not found.</div>`);
    const owns = await db.query.channels.findFirst({
      where: and(eq(channels.id, ev.channel_id), eq(channels.workspace_id, a.workspaceId)),
      columns: { id: true },
    });
    if (!owns) return c.html(html`<div class="notice notice-err">Event not found.</div>`);
    return c.html(renderWebhookDetail(ev));
  });

  // API keys — its own top-level page (create + revoke + scopes). Settings links here.
  app.get("/api-keys", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const [keys, license] = await Promise.all([loadKeys(a.workspaceId), getInstanceLicense()]);
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "API Keys" }),
        "/api-keys",
        html`<div class="page">
          <h1>API Keys ${license.features.has("api_access") ? "" : proLink(license.upgradeUrl, "PRO")}</h1>
          <p class="muted">Programmatic access to your workspace over the REST API (<a href="/api/docs" target="_blank" rel="noopener">docs</a>). Authenticate with <code>Authorization: Bearer rs_live_…</code>.</p>
          ${apiKeysSection(keys, license)}
        </div>`,
        license.features,
        license.products,
      ),
    );
  });

  // Sequences
  app.get("/sequences", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    // Building drip sequences is PRO — lock the whole page (consistent with inbox/contacts), not just
    // the builder form, so a free instance sees a clear upsell rather than an empty builder.
    if (!features.has("sequences")) {
      return c.html(
        dashboardDoc(t("title.suffix", { section: "Sequences" }), "/sequences", proLockMain("Sequences", html`Automated drip message sequences are a PRO feature.`, upgradeUrl), features, products),
      );
    }
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Sequences" }),
        "/sequences",
        html`<div class="page">
          <h1>Sequences</h1>
          <p class="muted">Automated drip message sequences. Each line below becomes a message step.</p>
          ${html`<details class="card" style="margin:1rem 0">
            <summary style="cursor:pointer;font-weight:600">+ New sequence</summary>
            <form hx-post="/sequences" hx-ext="json-enc" hx-target="#sequences-list" hx-swap="innerHTML" class="stack" style="margin-top:.75rem"
              x-data="{
                steps: [{ type: 'message', content: '', delay_minutes: 60 }],
                stepsJson() {
                  return JSON.stringify(this.steps
                    .filter(s => s.type === 'delay' ? Number(s.delay_minutes) > 0 : (s.content && s.content.trim()))
                    .map(s => s.type === 'delay'
                      ? { type: 'delay', delay_minutes: Number(s.delay_minutes) }
                      : { type: 'message', content: s.content.trim() }));
                }
              }">
              <div><label class="label">Name</label><input class="input" name="name" required /></div>
              <div><label class="label">Description</label><input class="input" name="description" /></div>
              <div><label class="label">Steps</label>
                <template x-for="(s, i) in steps" :key="i">
                  <div class="row" style="margin-bottom:.4rem">
                    <select class="input" x-model="s.type" style="max-width:160px">
                      <option value="message">Message</option>
                      <option value="delay">Delay (minutes)</option>
                    </select>
                    <input class="input" placeholder="Message text" x-model="s.content" x-show="s.type === 'message'" />
                    <input class="input" type="number" min="1" max="20160" placeholder="Minutes" x-model="s.delay_minutes" x-show="s.type === 'delay'" style="max-width:140px" />
                    <button class="btn btn-sm btn-danger" type="button" @click="steps.splice(i, 1)" x-show="steps.length > 1">×</button>
                  </div>
                </template>
                <button class="btn btn-sm" type="button" @click="steps.push({ type: 'message', content: '', delay_minutes: 60 })" x-show="steps.length < 50">+ step</button>
              </div>
              <input type="hidden" name="steps_json" :value="stepsJson()" />
              <button class="btn btn-primary" type="submit" style="align-self:flex-start">Create sequence</button>
            </form>
          </details>`}
          <div id="sequences-list">${renderSequences(await loadSequences(a.workspaceId))}</div>
        </div>`,
        features,
        products,
      ),
    );
  });

  app.post("/sequences", guard, async (c) => {
    const form = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    // The builder serializes typed steps (message OR delay) to steps_json; fall back to the legacy
    // one-line-per-message textarea if JS is off. The API validates delay_minutes etc.
    type SeqStep = { type: "message"; content: string } | { type: "delay"; delay_minutes: number };
    const fromJson = parseJsonArray(form.steps_json)
      .map((raw): SeqStep | null => {
        const o = raw as Record<string, unknown>;
        if (o.type === "delay") return { type: "delay", delay_minutes: Number(o.delay_minutes) };
        if (typeof o.content === "string" && o.content.trim()) return { type: "message", content: o.content.trim() };
        return null;
      })
      .filter((s): s is SeqStep => s !== null);
    const steps = fromJson.length
      ? fromJson
      : (form.steps ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((content) => ({ type: "message", content }));
    const payload = { name: form.name ?? "", description: form.description || undefined, steps };
    const res = await sequences.POST(jsonReq(c, payload));
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const list = renderSequences(await loadSequences(a.workspaceId));
    if (res.status >= 400) {
      const body = await res.json().catch(() => ({}));
      return c.html(html`<div class="notice notice-err">${body?.error?.message ?? "Could not create sequence."}</div>${list}`);
    }
    return c.html(list);
  });

  app.post("/sequences/:id/status", guard, async (c) => {
    const id = c.req.param("id");
    const form = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const res = await sequence
      .PATCH(jsonReqMethod(c, "PATCH", { status: form.status }), { params: Promise.resolve({ sequenceId: id }) })
      .catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    // Surface a failed status change instead of silently re-rendering the unchanged list.
    const error = !res || res.status >= 400 ? "Could not update the sequence status." : undefined;
    return c.html(renderSequences(await loadSequences(a.workspaceId), error));
  });

  app.delete("/sequences/:id", guard, async (c) => {
    const id = c.req.param("id");
    const res = await sequence.DELETE(c.req.raw, { params: Promise.resolve({ sequenceId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderSequences(await loadSequences(a.workspaceId), await noticeFrom(res, "Could not delete the sequence.")));
  });

  // Unified publishing sections (UNIFY1 Phase 3) — mounted on the same origin+session guard.
  registerChannels(app, guard);
  registerCompose(app, guard);
  registerContent(app, guard);
  registerBrands(app, guard);
  registerSources(app, guard);
  registerQueue(app, guard);
}

// jsonReqMethod allows non-POST verbs for delegated handlers (PATCH).
function jsonReqMethod(c: Context, method: string, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = c.req.header("cookie");
  if (cookie) headers.set("cookie", cookie);
  const authz = c.req.header("authorization");
  if (authz) headers.set("authorization", authz);
  return new Request(c.req.url, { method, headers, body: JSON.stringify(body) });
}

async function workspacePatch(c: Context, days: number | null): Promise<boolean> {
  const a = await auth(c);
  if (!a) return false;
  try {
    await db.update(workspaces).set({ message_retention_days: days }).where(eq(workspaces.id, a.workspaceId));
    return true;
  } catch {
    return false;
  }
}

// ─── contacts/keys/rules/sequences renderers ──────────────────────────────────

function loadContacts(workspaceId: string, q: string, limit = 50, channelId = "all", platform = "all", brand = "all") {
  const safeQ = q ? q.replace(/[%_\\]/g, "\\$&") : "";
  const conds: SQL[] = [eq(contacts.workspace_id, workspaceId)];
  if (safeQ) {
    const pat = `%${safeQ}%`;
    conds.push(
      or(
        ilike(contacts.display_name, pat),
        ilike(contacts.email, pat),
        exists(
          db
            .select({ x: sql`1` })
            .from(contactChannels)
            .where(
              and(
                eq(contactChannels.contact_id, contacts.id),
                or(ilike(contactChannels.platform_username, pat), like(contactChannels.platform_sender_id, pat)),
              ),
            ),
        ),
      )!,
    );
  }
  // Filter by the channel / platform a contact is linked to (via contact_channels). Auto-assignment
  // only — a contact is discovered per channel; this is display + filtering, not a manual move.
  if (channelId !== "all") {
    conds.push(
      exists(db.select({ x: sql`1` }).from(contactChannels).where(and(eq(contactChannels.contact_id, contacts.id), eq(contactChannels.channel_id, channelId)))),
    );
  } else if (platform !== "all") {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(contactChannels)
          .innerJoin(channels, eq(channels.id, contactChannels.channel_id))
          .where(and(eq(contactChannels.contact_id, contacts.id), eq(channels.platform, platform as (typeof channels.platform.enumValues)[number]))),
      ),
    );
  }
  // Filter by the brand owning a contact's channel(s). Independent of channel/platform filters.
  if (brand !== "all") {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(contactChannels)
          .innerJoin(channels, eq(channels.id, contactChannels.channel_id))
          .where(and(eq(contactChannels.contact_id, contacts.id), eq(channels.brand_key, brand))),
      ),
    );
  }
  return db.query.contacts.findMany({
    where: and(...conds),
    orderBy: desc(contacts.last_interaction_at),
    limit,
    columns: { id: true, display_name: true, email: true, is_subscribed: true, last_interaction_at: true },
    with: {
      contact_channels: {
        columns: { platform_sender_id: true, platform_username: true },
        limit: 3,
        with: { channel: { columns: { platform: true, display_name: true } } },
      },
    },
  });
}

function renderContacts(contacts: Awaited<ReturnType<typeof loadContacts>>, q = "", limit = 50, channelId = "all", platform = "all", brand = "all"): Html {
  if (contacts.length === 0) {
    return html`<p class="muted">${q || channelId !== "all" || platform !== "all" || brand !== "all" ? "No contacts match your filters." : "No contacts yet. Connect a channel and start receiving messages."}</p>`;
  }
  // A full page likely has more — offer to load the next batch by re-rendering with a larger limit
  // (the list was previously capped at 50 with no way to browse the rest). Carry the active filters.
  const more = contacts.length >= limit
    ? html`<button class="btn btn-sm" style="margin-top:.5rem" hx-get="/contacts/list?q=${encodeURIComponent(q)}&channel=${encodeURIComponent(channelId)}&platform=${encodeURIComponent(platform)}&brand=${encodeURIComponent(brand)}&limit=${limit + 50}" hx-target="#contacts-list" hx-swap="innerHTML">Load more</button>`
    : html``;
  return html`<table><thead><tr><th>Contact</th><th>Channels</th><th>Last seen</th></tr></thead><tbody>
    ${contacts.map(
      (ct) => html`<tr>
        <td>${ct.display_name ?? ct.contact_channels[0]?.platform_username ?? ct.contact_channels[0]?.platform_sender_id ?? "Unknown"}${ct.email ? html`<div class="muted" style="font-size:.75rem">${ct.email}</div>` : html``}${!ct.is_subscribed ? html`<div class="error" style="font-size:.7rem">Unsubscribed</div>` : html``}</td>
        <td>${ct.contact_channels.map((cc) => html`<span class="badge" title="${cc.channel.display_name ?? cc.channel.platform}" style="background:var(--muted);color:var(--muted-foreground);border:1px solid var(--border);margin-right:.35rem">${PLATFORM_LABELS[cc.channel.platform] ?? cc.channel.platform}${cc.platform_username ? html` · @${cc.platform_username}` : ""}</span>`)}</td>
        <td class="muted">${timeAgo(ct.last_interaction_at)}</td>
      </tr>`,
    )}
  </tbody></table>${more}`;
}

function loadKeys(workspaceId: string) {
  return db.query.apiKeys.findMany({
    where: eq(apiKeysTbl.workspace_id, workspaceId),
    orderBy: desc(apiKeysTbl.created_at),
    columns: { id: true, name: true, key_prefix: true, last_used_at: true, expires_at: true },
  });
}

function renderKeys(keys: Array<{ id: string; name: string; key_prefix: string; last_used_at: Date | null; expires_at: Date | null }>, error?: string): Html {
  const notice = error ? html`<div class="notice notice-err">${error}</div>` : html``;
  if (keys.length === 0) return html`${notice}<p class="muted">No API keys yet.</p>`;
  return html`${notice}<table><thead><tr><th>Name</th><th>Last used</th><th>Expiry</th><th></th></tr></thead><tbody>
    ${keys.map(
      (k) => html`<tr>
        <td>${k.name}<div class="muted mono" style="font-size:.75rem">${k.key_prefix}...</div></td>
        <td class="muted">${k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "Never"}</td>
        <td class="muted">${k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "No expiry"}</td>
        <td><button class="btn btn-sm btn-danger" hx-delete="/settings/api-keys/${k.id}" hx-target="#keys-area" hx-swap="innerHTML" hx-confirm="Revoke this API key?">Revoke</button></td>
      </tr>`,
    )}
  </tbody></table>`;
}

/** API-key management body (create form + key list). Lives on its own /api-keys page; the page
 *  supplies the H1, so this renders only the intro + form + list. */
function apiKeysSection(keys: Awaited<ReturnType<typeof loadKeys>>, license: Awaited<ReturnType<typeof getInstanceLicense>>): Html {
  const canApi = license.features.has("api_access");
  return html`
    <p class="muted" style="margin-bottom:1rem">Keys are shown once on creation — store them securely.${canApi ? "" : html` Creating API keys is a ${proLink(license.upgradeUrl, "PRO")} feature; existing keys are disabled while unlicensed.`}</p>
    <form hx-post="/settings/api-keys" hx-ext="json-enc" hx-target="#keys-area" hx-swap="innerHTML" class="stack" style="margin-bottom:1rem"
      x-data="${`{ scopes: ${JSON.stringify(apiKeys.VALID_SCOPES)}, scopesJson() { return JSON.stringify(this.scopes); } }`}">
      <div class="row">
        <input class="input" name="name" placeholder="Key name (e.g. Production webhook)" required />
        <button class="btn btn-primary" type="submit">Create</button>
      </div>
      <details class="card" style="font-size:.8rem">
        <summary style="cursor:pointer">Scopes (all selected = full access)</summary>
        <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem">
          ${apiKeys.VALID_SCOPES.map(
            (sc) => html`<label style="display:flex;gap:.25rem;align-items:center"><input type="checkbox" value="${sc}" checked
              @change="$event.target.checked ? (scopes = [...new Set([...scopes, '${sc}'])]) : (scopes = scopes.filter(s => s !== '${sc}'))" />${sc}</label>`,
          )}
        </div>
      </details>
      <input type="hidden" name="scopes_json" :value="scopesJson()" />
    </form>
    <div id="keys-area">${renderKeys(keys)}</div>`;
}

// A small "🔒 PRO" link to the upgrade URL, for locking gated controls in forms.
// A labelled, copy-to-clipboard config value (for the Meta App configuration panel).
function metaConfigRow(label: string, value: string): Html {
  return html`<div style="margin-bottom:.75rem">
    <div class="muted" style="font-size:.75rem;margin-bottom:.2rem">${label}</div>
    <div class="row" style="gap:.5rem;align-items:stretch" x-data="{ copied: false }">
      <code class="card mono grow" style="overflow-x:auto;white-space:nowrap;padding:.5rem .6rem">${value}</code>
      <button type="button" class="btn btn-sm" @click="navigator.clipboard.writeText($el.previousElementSibling.textContent); copied = true; setTimeout(() => copied = false, 1200)" x-text="copied ? '✓ Copied' : 'Copy'"></button>
    </div>
  </div>`;
}

function proLink(upgradeUrl: string, label = "PRO"): Html {
  return html`<a href="${upgradeUrl}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none;white-space:nowrap">🔒 ${label}</a>`;
}

// Full-page upsell shown when a free instance opens a PRO-only view (inbox / contacts).
// Free keeps unlimited message handling; seeing individual people is the paid CRM layer.
function proLockMain(title: string, body: Html, upgradeUrl: string): Html {
  return html`<div class="page">
    <h1>${title} <span class="badge">PRO</span></h1>
    <div class="card" style="max-width:38rem">
      <p>${body}</p>
      <p class="muted" style="font-size:.85rem">Your automations keep running on the free plan — the bot answers everyone, with unlimited messages and contacts. The inbox and contacts CRM, where you see and manage individual people, are part of PRO.</p>
      <a class="btn btn-primary" href="${upgradeUrl}" target="_blank" rel="noopener">Upgrade to PRO</a>
      <a class="btn" href="/overview">Back to overview</a>
    </div>
  </div>`;
}

const REACTION_EMOJI: Record<string, string> = {
  like: "👍", love: "❤️", care: "🥰", haha: "😆", wow: "😮", sad: "😢", angry: "😠",
};

type EngagementPost = { postId: string; channelName: string | null; total: number; lastAt: Date; byType: Array<{ type: string; n: number }>; reactors: string[] };

/** Group post reactions by post → per-type counts + a few reactor names. Identity-free shape is
 *  not required here (Engagement IS the PRO view), but we cap the reactor list for readability. */
async function loadEngagement(workspaceId: string): Promise<EngagementPost[]> {
  const rows = await db
    .select({
      post_id: postReactions.post_id,
      reaction_type: postReactions.reaction_type,
      reactor_name: postReactions.reactor_name,
      created_at: postReactions.created_at,
    })
    .from(postReactions)
    .where(eq(postReactions.workspace_id, workspaceId))
    .orderBy(desc(postReactions.created_at))
    .limit(1000);

  const byPost = new Map<string, { total: number; types: Map<string, number>; reactors: string[]; lastAt: Date }>();
  for (const r of rows) {
    let p = byPost.get(r.post_id);
    if (!p) byPost.set(r.post_id, (p = { total: 0, types: new Map(), reactors: [], lastAt: r.created_at }));
    p.total++;
    if (r.created_at > p.lastAt) p.lastAt = r.created_at;
    p.types.set(r.reaction_type, (p.types.get(r.reaction_type) ?? 0) + 1);
    if (r.reactor_name && p.reactors.length < 8 && !p.reactors.includes(r.reactor_name)) p.reactors.push(r.reactor_name);
  }
  // Resolve the owning page for each post: FB post ids are `{pageId}_{postId}`, and the page id is a
  // facebook channel's platform_id — so we can show the page name instead of just a raw id.
  const fbChannels = await db.query.channels.findMany({
    where: and(eq(channels.workspace_id, workspaceId), eq(channels.platform, "facebook")),
    columns: { platform_id: true, display_name: true },
  });
  const pageName = new Map(fbChannels.map((ch) => [ch.platform_id, ch.display_name] as const));
  return [...byPost.entries()]
    .map(([postId, p]) => ({
      postId,
      channelName: pageName.get(postId.split("_")[0] ?? "") ?? null,
      total: p.total,
      lastAt: p.lastAt,
      byType: [...p.types.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
      reactors: p.reactors,
    }))
    .sort((a, b) => b.total - a.total);
}

type DmReaction = { who: string; platform: string; emoji: string; type: string; at: Date };

/** Reactions left on OUR direct messages (the only reaction signal Instagram delivers over webhooks;
 *  Facebook DMs too). Joined to the contact for a display name and the channel for the platform. */
async function loadMessageReactions(workspaceId: string): Promise<DmReaction[]> {
  const rows = await db
    .select({
      type: messageReactions.reaction_type,
      emoji: messageReactions.emoji,
      created_at: messageReactions.created_at,
      who: contacts.display_name,
      platform: channels.platform,
    })
    .from(messageReactions)
    .leftJoin(contacts, eq(contacts.id, messageReactions.contact_id))
    .leftJoin(channels, eq(channels.id, messageReactions.channel_id))
    .where(eq(messageReactions.workspace_id, workspaceId))
    .orderBy(desc(messageReactions.created_at))
    .limit(50);
  return rows.map((r) => ({
    who: r.who ?? "Someone",
    platform: r.platform ?? "—",
    emoji: r.emoji ?? REACTION_EMOJI[r.type] ?? "💬",
    type: r.type,
    at: r.created_at,
  }));
}

function renderEngagement(posts: EngagementPost[], dms: DmReaction[]): Html {
  return html`<div class="page">
    <h1>Engagement</h1>
    <p class="muted">Who reacted to your posts and messages.</p>

    <p class="muted" style="margin:.25rem 0 1rem">
      <strong>Platform coverage:</strong> Facebook delivers <em>post</em> reactions (shown below).
      Instagram does <strong>not</strong> send <strong>post likes</strong> or reactions over its API,
      so they can't appear here — Instagram engagement instead arrives as <em>message reactions</em>
      (further down) and as comments in your <a href="/inbox">Inbox</a>.
    </p>

    <h2 style="margin-top:1rem">Post reactions <span class="muted" style="font-weight:400">· Facebook</span></h2>
    ${posts.length === 0
      ? html`<p class="muted">No post reactions yet. Reactions on your Facebook posts will show up here.</p>`
      : html`<table><thead><tr><th>Post</th><th>Reactions</th><th>Breakdown</th><th>Who</th><th>Latest</th></tr></thead>
          <tbody>
            ${posts.map(
              (p) => html`<tr>
                <td style="font-size:.82rem">
                  ${p.channelName ? html`<div style="font-weight:600">${p.channelName}</div>` : ""}
                  <a href="https://www.facebook.com/${p.postId}" target="_blank" rel="noopener">View post ↗</a>
                  <div class="muted mono" style="font-size:.68rem">${p.postId}</div>
                </td>
                <td><strong>${p.total}</strong></td>
                <td>${p.byType.map((t) => html`<span class="badge" title="${t.type}">${REACTION_EMOJI[t.type] ?? t.type} ${t.n}</span> `)}</td>
                <td class="muted" style="font-size:.8rem">${p.reactors.length ? p.reactors.join(", ") : "—"}</td>
                <td class="muted" style="font-size:.78rem">${timeAgo(p.lastAt)}</td>
              </tr>`,
            )}
          </tbody></table>`}

    <h2 style="margin-top:1.5rem">Message reactions <span class="muted" style="font-weight:400">· Facebook &amp; Instagram DMs</span></h2>
    ${dms.length === 0
      ? html`<p class="muted">No message reactions yet. When someone reacts to one of your direct messages, it shows up here.</p>`
      : html`<table><thead><tr><th>Who</th><th>Reaction</th><th>Platform</th><th>When</th></tr></thead>
          <tbody>
            ${dms.map(
              (d) => html`<tr>
                <td>${d.who}</td>
                <td><span class="badge" title="${d.type}">${d.emoji} ${d.type}</span></td>
                <td class="muted">${d.platform}</td>
                <td class="muted" style="font-size:.8rem">${d.at.toISOString().slice(0, 16).replace("T", " ")}</td>
              </tr>`,
            )}
          </tbody></table>`}
  </div>`;
}

interface OverviewPublishing {
  attention: AttentionRow[];
  upcoming: UpcomingPost[];
  recent: RecentEvent[];
}

/** The publishing wing's slice of the unified overview: attention hero + upcoming + recent events. */
function renderPublishingOverview(pub: OverviewPublishing): Html {
  const attention = pub.attention.length
    ? html`<section class="panel" style="margin:1rem 0">
        <div class="panel-head"><h3>Needs attention</h3><span class="panel-count">${pub.attention.length}</span></div>
        ${pub.attention.map(
          (a) => html`<div class="attn-row">
            ${dot(a.tone)}
            <span class="attn-title" title="${a.reason}">${a.title} <span class="muted" style="font-weight:400">· ${a.reason}</span></span>
            <span class="attn-acts"><a class="btn btn-sm ${a.action.variant === "primary" ? "btn-primary" : "btn-secondary"}" href="${a.action.href}">${a.action.label}</a></span>
          </div>`,
        )}
      </section>`
    : html`<section class="panel" style="margin:1rem 0"><div class="panel-head"><h3>Needs attention</h3></div><div class="empty"><p class="empty-title">All healthy ✓</p><p class="empty-body">No channels, sources or deliveries need a fix.</p></div></section>`;
  const upcoming = html`<section class="panel">
      <div class="panel-head"><h3>Upcoming</h3><a class="panel-more" href="/queue?status=scheduled">Queue →</a></div>
      ${pub.upcoming.length
        ? pub.upcoming.map((u) => html`<div class="up-row"><span class="up-time">${relTimeShort(u.scheduledAt)}</span><span class="up-title">${PLATFORM_LABELS[u.platform] ?? u.platform} · ${u.format}</span><span class="up-channel">${u.channelName}</span></div>`)
        : html`<div class="rec-empty"><small>Nothing scheduled.</small></div>`}
    </section>`;
  const recent = html`<section class="panel">
      <div class="panel-head"><h3>Recent events</h3><a class="panel-more" href="/events">Events →</a></div>
      ${pub.recent.length
        ? pub.recent.map((e) => html`<div class="feed-row"><span class="feed-main"><span class="feed-type">${e.type}</span></span><span class="feed-time">${timeAgo(e.createdAt)}</span></div>`)
        : html`<div class="rec-empty"><small>No events yet.</small></div>`}
    </section>`;
  return html`${attention}<div class="dash-grid">${upcoming}${recent}</div>`;
}

/** A compact relative time for the upcoming feed ("in 22m" / "12d ago"). */
function relTimeShort(at: Date): string {
  const ms = at.getTime() - Date.now();
  const abs = Math.abs(ms);
  const day = 86400000;
  const v = abs < 3600000 ? `${Math.max(1, Math.round(abs / 60000))}m` : abs < day ? `${Math.round(abs / 3600000)}h` : `${Math.round(abs / day)}d`;
  return ms >= 0 ? `in ${v}` : `${v} ago`;
}

function renderOverview(ov: Awaited<ReturnType<typeof loadOverview>>, features: Set<Feature>, upgradeUrl: string, pub: OverviewPublishing | null = null): Html {
  const locked = !features.has("contacts_crm");
  return html`<div class="page">
    <h1>Overview</h1>
    <p class="section-intro">Your automation at a glance.${locked ? html` Replying to conversations by hand is ${proLink(upgradeUrl, "PRO")} — your rules auto-reply for free.` : html``}</p>
    <div class="kpis" style="margin:14px 0">
      ${kpi({ label: "Sent today", value: ov.today, tone: "neutral" })}
      ${kpi({ label: "Sent (all time)", value: ov.sent, tone: "ok" })}
      ${kpi({ label: "Failed", value: ov.failed, tone: ov.failed > 0 ? "bad" : "neutral" })}
      ${kpi({ label: "Held", value: ov.held, tone: ov.held > 0 ? "warn" : "neutral" })}
      ${kpi({ label: "Contacts", value: ov.contactCount, tone: "neutral" })}
    </div>
    ${pub ? renderPublishingOverview(pub) : ""}
    <section class="section">
      <h2>Recent activity</h2>
      ${ov.recentSends.length === 0
        ? html`<p class="muted">No messages sent yet. Connect a channel and add a keyword rule to start auto-replying.</p>`
        : html`<table><thead><tr><th>Type</th><th>Channel</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              ${ov.recentSends.map(
                (r) => html`<tr>
                  <td>${r.label}</td>
                  <td class="muted">${r.platform ? PLATFORM_LABELS[r.platform] ?? r.platform : "—"}</td>
                  <td><span class="badge">${r.status}</span></td>
                  <td class="muted">${timeAgo(r.createdAt)}</td>
                </tr>`,
              )}
            </tbody></table>
          ${locked ? html`<p class="muted" style="font-size:.8rem;margin-top:.75rem">This log shows what was sent, without client details. To see who you talked to, ${proLink(upgradeUrl, "upgrade to PRO")}.</p>` : html``}`}
    </section>
  </div>`;
}

/** Read-only publishing-provider status (merged from PostStack settings): which publish providers
 *  are registered and whether their OAuth client env is configured. Self-hoster diagnostic. */
function renderProvidersStatus(): Html {
  const providers = listProviders();
  return html`<section class="section">
    <h2>Publishing providers</h2>
    <p class="muted" style="margin-bottom:1rem">Which publishing providers are available and whether their OAuth client credentials are configured.</p>
    <table><thead><tr><th>Provider</th><th>OAuth</th></tr></thead><tbody>
      ${providers.map((p) => {
        const configured = !!p.oauthConfig?.();
        return html`<tr><td>${p.id}</td><td>${configured ? pillBadge("configured", "ok") : pillBadge("not configured", "neutral")}</td></tr>`;
      })}
    </tbody></table>
  </section>`;
}

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
      <div><strong>Status:</strong> <span class="badge">${state.status}</span>${state.tier ? html` &nbsp;<strong>Tier:</strong> ${state.tier}` : html``}${state.expiresAt ? html` &nbsp;<span class="muted">expires ${new Date(state.expiresAt).toLocaleDateString()}</span>` : html``}</div>
      ${state.products.size > 0 ? html`<div style="margin-top:.4rem"><strong>Products:</strong> ${[...state.products].map((p) => html`<span class="badge">${p}</span> `)}</div>` : html``}
      ${state.features.size > 0 ? html`<div class="muted" style="margin-top:.4rem">Unlocked: ${[...state.features].join(", ")}</div>` : html``}
      <div class="muted" style="margin-top:.4rem;font-size:.8rem">Source: ${sourceLabel}</div>
    </div>
    <div class="row">
      ${state.status !== "active" ? html`<a class="btn btn-primary" href="${state.upgradeUrl}" target="_blank" rel="noopener">Buy PRO</a>` : html``}
      ${state.source === "db" ? html`<button class="btn btn-sm" hx-post="/settings/license/clear" hx-target="#license-area" hx-swap="innerHTML" hx-confirm="Remove the stored license token?">Remove license</button>` : html``}
    </div>`;
}

/** Parse a JSON-array string from the rule form (quick replies / buttons); returns [] on anything else. */
function parseJsonArray(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadRules(workspaceId: string) {
  return db.query.autoReplyRules.findMany({
    where: eq(autoReplyRules.workspace_id, workspaceId),
    orderBy: [desc(autoReplyRules.priority), asc(autoReplyRules.created_at)],
    limit: 200,
    columns: { id: true, name: true, is_active: true, trigger_type: true, response_type: true },
  });
}

function renderRules(rulesList: Awaited<ReturnType<typeof loadRules>>, error?: string): Html {
  const notice = error ? html`<div class="notice notice-err">${error}</div>` : html``;
  if (rulesList.length === 0) return html`${notice}<p class="muted">No rules yet.</p>`;
  return html`${notice}<div class="list">${rulesList.map(
    (r) => html`<div class="list-row">
      <div class="grow"><span style="font-weight:600">${r.name}</span> <span class="muted" style="font-size:.75rem">${r.trigger_type} → ${r.response_type}${r.is_active ? "" : " · inactive"}</span></div>
      <button class="btn btn-sm" hx-get="/rules/${r.id}/edit" hx-target="#rules-list" hx-swap="innerHTML">Edit</button>
      <button class="btn btn-sm" hx-post="/rules/${r.id}/toggle" hx-target="#rules-list" hx-swap="innerHTML">${r.is_active ? "Pause" : "Activate"}</button>
      <button class="btn btn-sm btn-danger" hx-delete="/rules/${r.id}" hx-target="#rules-list" hx-swap="innerHTML" hx-confirm="Delete this rule?">Delete</button>
    </div>`,
  )}</div>`;
}

function loadRuleForEdit(workspaceId: string, id: string) {
  return db.query.autoReplyRules.findFirst({
    where: and(eq(autoReplyRules.id, id), eq(autoReplyRules.workspace_id, workspaceId)),
    columns: { id: true, name: true, trigger_type: true, trigger_config: true, response_type: true, response_config: true, requires_approval: true },
  });
}

/** Inline edit form for a rule. Exposes the common fields; advanced response config (buttons,
 *  quick replies, follow-gate) is preserved untouched by the update route, not edited here. */
function renderRuleEditForm(r: NonNullable<Awaited<ReturnType<typeof loadRuleForEdit>>>): Html {
  const tc = (r.trigger_config ?? {}) as Record<string, unknown>;
  const rc = (r.response_config ?? {}) as Record<string, unknown>;
  const keywords = Array.isArray(tc.keywords)
    ? (tc.keywords as Array<string | { value?: string }>).map((k) => (typeof k === "string" ? k : k.value ?? "")).filter(Boolean).join(", ")
    : "";
  const postId = typeof tc.post_id === "string" ? tc.post_id : "";
  const text = typeof rc.text === "string" ? rc.text : "";
  const replyMode = typeof rc.reply_mode === "string" ? rc.reply_mode : "dm";
  const commentReply = typeof rc.comment_reply_text === "string" ? rc.comment_reply_text : "";
  const isText = r.response_type === "text";
  const isKeyword = r.trigger_type === "keyword" || r.trigger_type === "comment_keyword";
  const isComment = r.trigger_type === "comment_keyword";
  const hasAdvanced = (Array.isArray(rc.buttons) && rc.buttons.length > 0) || (Array.isArray(rc.quick_replies) && rc.quick_replies.length > 0);
  const sel = (v: string) => (v === replyMode ? raw(" selected") : raw(""));
  return html`<div class="card" style="margin-bottom:1rem">
    <h3 style="margin-top:0">Edit rule <span class="muted" style="font-weight:400;font-size:.8rem">${r.trigger_type} → ${r.response_type}</span></h3>
    <form hx-post="/rules/${r.id}" hx-ext="json-enc" hx-target="#rules-list" hx-swap="innerHTML" class="stack">
      <div><label class="label">Name</label><input class="input" name="name" value="${r.name}" required /></div>
      ${isKeyword ? html`<div><label class="label">Keywords (comma-separated)</label><input class="input" name="keywords" value="${keywords}" placeholder="hello, hi, info" /></div>` : ""}
      ${isComment ? html`<div><label class="label">Post ID (blank = any post)</label><input class="input" name="post_id" value="${postId}" placeholder="leave blank for any post" /></div>` : ""}
      ${isComment && isText ? html`<div><label class="label">Reply via</label>
        <select class="input" name="reply_mode">
          <option value="dm"${sel("dm")}>DM only</option>
          <option value="comment"${sel("comment")}>Public comment only</option>
          <option value="both"${sel("both")}>Both</option>
        </select></div>` : ""}
      ${isText
        ? html`<div><label class="label">Reply text</label><textarea class="textarea" name="text" rows="2">${text}</textarea></div>`
        : html`<p class="muted" style="font-size:.78rem">This rule's response type is <strong>${r.response_type}</strong>; its detailed configuration is preserved on save. To rebuild it, delete and recreate the rule.</p>`}
      ${isComment && isText ? html`<div><label class="label">Public comment reply text (optional)</label><input class="input" name="comment_reply_text" value="${commentReply}" /></div>` : ""}
      ${hasAdvanced ? html`<p class="muted" style="font-size:.72rem">ℹ Buttons / quick replies on this rule are kept as-is.</p>` : ""}
      <label style="display:flex;align-items:center;gap:.5rem;font-size:.875rem;cursor:pointer">
        <input type="checkbox" name="requires_approval" value="true"${r.requires_approval ? raw(" checked") : raw("")} />
        Hold for human approval before sending
      </label>
      <div class="row" style="gap:.5rem">
        <button class="btn btn-primary" type="submit">Save changes</button>
        <button class="btn btn-sm" type="button" hx-get="/rules/list" hx-target="#rules-list" hx-swap="innerHTML">Cancel</button>
      </div>
    </form>
  </div>`;
}

function loadApprovals(workspaceId: string) {
  return db
    .select({
      id: pendingApprovals.id,
      recipient: pendingApprovals.recipient_platform_id,
      proposed: pendingApprovals.proposed_content,
      created_at: pendingApprovals.created_at,
      ruleName: autoReplyRules.name,
    })
    .from(pendingApprovals)
    .leftJoin(autoReplyRules, eq(autoReplyRules.id, pendingApprovals.rule_id))
    .where(and(eq(pendingApprovals.workspace_id, workspaceId), eq(pendingApprovals.status, "pending")))
    .orderBy(desc(pendingApprovals.created_at))
    .limit(100);
}

function renderApprovals(list: Awaited<ReturnType<typeof loadApprovals>>, error?: string): Html {
  const notice = error ? html`<div class="notice notice-err">${error}</div>` : html``;
  if (list.length === 0) return html`${notice}<p class="muted">Nothing waiting for approval.</p>`;
  return html`${notice}<div class="list">${list.map((a) => {
    const content = ((a.proposed as { content?: { text?: string; buttons?: unknown[]; quick_replies?: unknown[] } } | null)?.content) ?? {};
    const preview = content.text ?? "(no text)";
    const extras = [
      content.buttons?.length ? `${content.buttons.length} button(s)` : null,
      content.quick_replies?.length ? `${content.quick_replies.length} quick repl(ies)` : null,
    ].filter(Boolean).join(" · ");
    return html`<div class="list-row">
      <div class="grow">
        <div style="font-weight:600">${a.ruleName ?? "rule"} <span class="muted" style="font-size:.75rem">→ ${a.recipient} · ${timeAgo(a.created_at)}</span></div>
        <div style="font-size:.875rem;white-space:pre-wrap">${preview}</div>
        ${extras ? html`<div class="muted" style="font-size:.7rem">${extras}</div>` : html``}
      </div>
      <button class="btn btn-sm btn-primary" hx-post="/approvals/${a.id}/approve" hx-target="#approvals-list" hx-swap="innerHTML">Approve</button>
      <button class="btn btn-sm btn-danger" hx-post="/approvals/${a.id}/reject" hx-target="#approvals-list" hx-swap="innerHTML">Reject</button>
    </div>`;
  })}</div>`;
}

async function loadSequences(workspaceId: string) {
  const rows = await db.query.sequences.findMany({
    where: eq(sequencesTbl.workspace_id, workspaceId),
    orderBy: desc(sequencesTbl.created_at),
    columns: { id: true, name: true, status: true, steps: true },
  });
  // One grouped enrollment count for all sequences instead of a $count per sequence.
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({ sequence_id: sequenceEnrollments.sequence_id, n: count() })
        .from(sequenceEnrollments)
        .where(inArray(sequenceEnrollments.sequence_id, ids))
        .groupBy(sequenceEnrollments.sequence_id)
    : [];
  const bySeq = new Map(counts.map((c) => [c.sequence_id, Number(c.n)]));
  return rows.map((seq) => ({ ...seq, _count: { enrollments: bySeq.get(seq.id) ?? 0 } }));
}

function renderSequences(seqs: Awaited<ReturnType<typeof loadSequences>>, error?: string): Html {
  const notice = error ? html`<div class="notice notice-err">${error}</div>` : html``;
  if (seqs.length === 0) return html`${notice}<p class="muted">No sequences yet.</p>`;
  return html`${notice}<div class="list">${seqs.map((seq) => {
    const stepCount = Array.isArray(seq.steps) ? seq.steps.length : 0;
    return html`<div class="list-row">
      <div class="grow"><span style="font-weight:600">${seq.name}</span> <span class="muted" style="font-size:.75rem">${seq.status.toUpperCase()} · ${stepCount} steps · ${seq._count.enrollments} enrolled</span></div>
      ${seq.status === "draft" ? html`<button class="btn btn-sm" hx-post="/sequences/${seq.id}/status" hx-ext="json-enc" hx-vals='{"status":"active"}' hx-target="#sequences-list" hx-swap="innerHTML">Activate</button>` : html``}
      ${seq.status === "active" ? html`<button class="btn btn-sm" hx-post="/sequences/${seq.id}/status" hx-ext="json-enc" hx-vals='{"status":"archived"}' hx-target="#sequences-list" hx-swap="innerHTML">Archive</button>` : html``}
      ${seq.status === "archived" ? html`<button class="btn btn-sm" hx-post="/sequences/${seq.id}/status" hx-ext="json-enc" hx-vals='{"status":"active"}' hx-target="#sequences-list" hx-swap="innerHTML">Restore</button>` : html``}
      <button class="btn btn-sm btn-danger" hx-delete="/sequences/${seq.id}" hx-target="#sequences-list" hx-swap="innerHTML" hx-confirm="Delete this sequence?">Delete</button>
    </div>`;
  })}</div>`;
}
