import type { Hono, MiddlewareHandler, Context } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { and, or, eq, asc, desc, ilike, like, exists, inArray, sql, count, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  conversations, messages, channels, contacts, contactChannels,
  apiKeys as apiKeysTbl, autoReplyRules, sequences as sequencesTbl, sequenceEnrollments, workspaces,
  pendingApprovals, outboundDeliveries,
} from "@/db/schema";
import { authenticate, type AuthContext } from "@/lib/auth";
import { MAX_RETENTION_DAYS } from "@/lib/retention";
import { env } from "@/lib/env";
import * as channel from "@/server/handlers/v1/channels/[channelId]/route";
import * as channelDrain from "@/server/handlers/v1/channels/[channelId]/drain/route";
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
    last_message_preview: true, unread_count: true,
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

function renderConvList(conversations: Array<Awaited<ReturnType<typeof loadConversations>>[number]>): Html {
  if (conversations.length === 0) {
    return html`<div class="conv-head">Inbox</div><p class="muted" style="padding:1rem">No conversations yet. Connect a channel to start receiving messages.</p>`;
  }
  return html`<div class="conv-head">Inbox</div>
    ${conversations.map(
      (conv) => html`<button class="conv-item" hx-get="/inbox/${conv.id}" hx-target="#thread" hx-swap="innerHTML">
        <div class="conv-top">
          <span class="conv-name ${conv.unread_count > 0 ? "unread" : ""}">${contactName(conv)}</span>
          <span class="conv-time">${timeAgo(conv.last_message_at)}</span>
        </div>
        <div class="conv-preview">${conv.last_message_preview ?? "No messages"}</div>
        ${conv.unread_count > 0 ? html`<span class="badge">${conv.unread_count}</span>` : html``}
      </button>`,
    )}`;
}

function renderMessages(messages: Array<{ id: string; direction: string; text: string | null }>): Html {
  if (messages.length === 0) return html`<p class="muted">No messages yet.</p>`;
  return html`${messages.map(
    (m) => html`<div class="msg ${m.direction === "outbound" ? "msg-out" : "msg-in"}"><div class="bubble">${m.text ?? "(attachment)"}</div></div>`,
  )}`;
}

type ConvControls = { id: string; status: string; is_automation_paused: boolean; needs_manual_reply: boolean; assigned_to: string | null; channel: { display_name: string | null; platform: string } };

/** The conversation control bar: status + close/snooze/reopen, automation pause toggle, and the
 *  attention/assignment indicators — all wired to PATCH /conversations/:id. */
function renderConvControls(conv: ConvControls): Html {
  const statusBtn = (label: string, status: string) =>
    html`<button class="btn btn-sm" hx-post="/inbox/${conv.id}/conversation" hx-ext="json-enc" hx-vals='${`{"status":"${status}"}`}' hx-target="#thread" hx-swap="innerHTML">${label}</button>`;
  return html`<div class="thread-controls" style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;font-size:.8rem;margin:.25rem 0">
    <span class="badge">${conv.status}</span>
    ${conv.needs_manual_reply ? html`<span class="badge" style="background:#b91c1c">⚠ Needs reply</span>` : html``}
    ${conv.is_automation_paused ? html`<span class="badge" style="background:#b45309">⏸ Automation paused</span>` : html``}
    ${conv.assigned_to ? html`<span class="muted">assigned</span>` : html``}
    ${conv.status === "open" ? html`${statusBtn("Close", "closed")}${statusBtn("Snooze", "snoozed")}` : statusBtn("Reopen", "open")}
    <button class="btn btn-sm" hx-post="/inbox/${conv.id}/conversation" hx-ext="json-enc" hx-vals='${`{"is_automation_paused":${conv.is_automation_paused ? "false" : "true"}}`}' hx-target="#thread" hx-swap="innerHTML">${conv.is_automation_paused ? "Resume automation" : "Pause automation"}</button>
  </div>`;
}

function renderThread(
  conv: ConvName & ConvControls,
  messages: Array<{ id: string; direction: string; text: string | null }>,
  // On a failed send, show the error and keep the operator's typed text instead of clearing it
  // out as if the message went.
  opts: { error?: string; draft?: string } = {},
): Html {
  return html`<div class="thread-head">${contactName(conv)} <span class="muted">via ${conv.channel.display_name ?? conv.channel.platform}</span></div>
    ${renderConvControls(conv)}
    ${opts.error ? html`<div class="notice notice-err">${opts.error}</div>` : html``}
    <div id="thread-msgs" class="thread-msgs" hx-get="/inbox/${conv.id}/messages" hx-trigger="every 5s" hx-swap="innerHTML">${renderMessages(messages)}</div>
    <form class="reply-bar" hx-post="/inbox/${conv.id}/reply" hx-ext="json-enc" hx-target="#thread" hx-swap="innerHTML">
      <textarea class="textarea" name="text" rows="2" placeholder="Type a reply..." required>${opts.draft ?? ""}</textarea>
      <button class="btn btn-primary" type="submit">Send</button>
    </form>`;
}

function loadConversations(workspaceId: string) {
  return db.query.conversations.findMany({
    where: eq(conversations.workspace_id, workspaceId),
    orderBy: desc(conversations.last_message_at),
    limit: 50,
    ...CONV_QUERY,
  });
}

function loadConversation(id: string, workspaceId: string) {
  return db.query.conversations.findFirst({
    where: and(eq(conversations.id, id), eq(conversations.workspace_id, workspaceId)),
    ...CONV_QUERY,
  });
}

function loadMessages(conversationId: string) {
  return db.query.messages
    .findMany({
      where: eq(messages.conversation_id, conversationId),
      orderBy: desc(messages.created_at),
      limit: 50,
      columns: { id: true, direction: true, text: true, created_at: true },
    })
    .then((m) => m.reverse());
}

// ─── channels ─────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = { facebook: "Facebook", instagram: "Instagram" };
const CHANNEL_ERRORS: Record<string, string> = {
  access_denied: "Access denied — you cancelled the connection.",
  no_pages: "No Facebook Pages found. Make sure you manage at least one Page.",
  no_ig_accounts: "No Instagram Business accounts found linked to your Pages.",
  oauth_failed: "Connection failed. Please try again.",
  invalid_state: "Invalid request state. Please try again.",
  missing_params: "Missing parameters from platform. Please try again.",
};

async function loadChannels(workspaceId: string) {
  const rows = await db.query.channels.findMany({
    where: eq(channels.workspace_id, workspaceId),
    orderBy: asc(channels.created_at),
    columns: {
      id: true, platform: true, platform_id: true, display_name: true, username: true,
      profile_picture: true, status: true, connection_mode: true,
    },
  });
  // Grouped counts for every channel in one query each, instead of a COUNT per channel (N+1 on each
  // /channels load + after every action) — joined in memory. `unknown` deliveries are sends
  // interrupted after dispatch (maybe-delivered): they were previously only visible in psql, so
  // surface a per-channel count next to `held` for the operator to reconcile.
  const ids = rows.map((r) => r.id);
  const [heldCounts, unknownCounts] = ids.length
    ? await Promise.all([
        db
          .select({ channel_id: conversations.channel_id, n: count() })
          .from(messages)
          .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
          .where(and(eq(messages.status, "held"), inArray(conversations.channel_id, ids)))
          .groupBy(conversations.channel_id),
        db
          .select({ channel_id: outboundDeliveries.channel_id, n: count() })
          .from(outboundDeliveries)
          .where(and(eq(outboundDeliveries.status, "unknown"), inArray(outboundDeliveries.channel_id, ids)))
          .groupBy(outboundDeliveries.channel_id),
      ])
    : [[], []];
  const heldByChannel = new Map(heldCounts.map((h) => [h.channel_id, Number(h.n)]));
  const unknownByChannel = new Map(unknownCounts.map((u) => [u.channel_id, Number(u.n)]));
  return rows.map((ch) => ({
    ...ch,
    held_count: heldByChannel.get(ch.id) ?? 0,
    unknown_count: unknownByChannel.get(ch.id) ?? 0,
  }));
}

function renderChannels(channels: Awaited<ReturnType<typeof loadChannels>>, error?: string): Html {
  const notice = error ? html`<div class="notice notice-err">${error}</div>` : html``;
  if (channels.length === 0) return html`${notice}<p class="muted">No channels connected yet.</p>`;
  return html`${notice}<div class="list">${channels.map(
    (ch) => html`<div class="list-row">
      ${ch.profile_picture ? html`<img class="avatar" src="${ch.profile_picture}" alt="" />` : html``}
      <div class="grow">
        <div style="font-weight:600">${ch.display_name ?? ch.username ?? ch.platform_id}</div>
        <div class="muted" style="font-size:.75rem">
          ${PLATFORM_LABELS[ch.platform] ?? ch.platform}${ch.username ? ` · @${ch.username}` : ""}${ch.status === "needs_reauth" ? " · ⚠ Needs reconnect" : ""}${ch.status === "paused" ? " · Paused" : ""}${ch.status === "disabled" ? " · Disabled" : ""}${ch.connection_mode === "manual_token" ? " · 🔑 Long-lived token" : ""}${ch.held_count > 0 ? ` · ${ch.held_count} held` : ""}${ch.unknown_count > 0 ? ` · ⚠ ${ch.unknown_count} unknown` : ""}
        </div>
      </div>
      ${ch.held_count > 0 ? html`<button class="btn btn-sm" hx-post="/channels/${ch.id}/drain" hx-target="#channels-list" hx-swap="innerHTML">↻ Retry held</button>` : html``}
      <button class="btn btn-sm" hx-delete="/channels/${ch.id}" hx-target="#channels-list" hx-swap="innerHTML" hx-confirm="Disconnect this channel? Auto-replies will stop for this account.">Disconnect</button>
    </div>`,
  )}</div>`;
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

export function registerDashboard(app: Hono, guard: MiddlewareHandler): void {
  // Inbox
  app.get("/inbox", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const conversations = await loadConversations(a.workspaceId);
    return c.html(
      dashboardDoc(
        "Inbox · ReplyStack",
        "/inbox",
        html`<div class="inbox">
          <div class="conv-list">${renderConvList(conversations)}</div>
          <div id="thread" class="thread"><div class="thread-empty">Select a conversation</div></div>
        </div>`,
      ),
    );
  });

  app.get("/inbox/:id", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    const conv = await loadConversation(id, a.workspaceId);
    if (!conv) return c.notFound();
    // workspace_id alongside the PK keeps the unread reset tenant-scoped.
    await db.update(conversations).set({ unread_count: 0 }).where(and(eq(conversations.id, id), eq(conversations.workspace_id, a.workspaceId))).catch(() => {});
    const msgs = await loadMessages(id);
    return c.html(renderThread(conv, msgs));
  });

  app.get("/inbox/:id/messages", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    const conv = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, id), eq(conversations.workspace_id, a.workspaceId)),
      columns: { id: true },
    });
    if (!conv) return c.notFound();
    return c.html(renderMessages(await loadMessages(id)));
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
    const conv = await loadConversation(id, a.workspaceId);
    if (!conv) return c.notFound();
    if (!res || res.status >= 400) {
      const errBody = res ? ((await res.json().catch(() => null)) as { error?: { message?: string } } | null) : null;
      const error = errBody?.error?.message ?? "Could not send the reply. Please try again.";
      return c.html(renderThread(conv, await loadMessages(id), { error, draft }));
    }
    return c.html(renderThread(conv, await loadMessages(id)));
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
    const conv = await loadConversation(id, a.workspaceId);
    if (!conv) return c.notFound();
    const error = !res || res.status >= 400 ? await noticeFrom(res, "Could not update the conversation.") : undefined;
    return c.html(renderThread(conv, await loadMessages(id), { error }));
  });

  // Channels
  app.get("/channels", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const channels = await loadChannels(a.workspaceId);
    const connected = c.req.query("connected");
    const count = c.req.query("count");
    const errorKey = c.req.query("error");
    return c.html(
      dashboardDoc(
        "Channels · ReplyStack",
        "/channels",
        html`<div class="page">
          <h1>Channels</h1>
          <p class="muted">Connect your Facebook Pages and Instagram Business accounts.</p>
          ${errorKey ? html`<div class="notice notice-err">${CHANNEL_ERRORS[errorKey] ?? "Something went wrong."}</div>` : html``}
          ${connected && count ? html`<div class="notice notice-ok">${count} ${PLATFORM_LABELS[connected] ?? connected} account(s) connected.</div>` : html``}
          <div x-data="{ token: false, tg: false }">
            <div class="row" style="margin:1rem 0 1rem">
              <a class="btn" style="background:#1877f2;color:#fff;border:none" href="/api/oauth/facebook">+ Facebook</a>
              <a class="btn" style="background:#bc1888;color:#fff;border:none" href="/api/oauth/instagram">+ Instagram</a>
              <button class="btn" type="button" style="background:#229ED9;color:#fff;border:none" @click="tg = !tg">+ Telegram</button>
              <button class="btn" type="button" @click="token = !token">Paste token</button>
            </div>
            <div x-show="token" x-cloak class="card" style="margin-bottom:1.5rem">
              <p class="muted" style="margin-bottom:.75rem">Connect with a long-lived / System User token (no 60-day refresh cycle).</p>
              <form hx-post="/channels/connect-token" hx-ext="json-enc" hx-target="#channels-list" hx-swap="innerHTML" class="stack">
                <select class="input" name="platform"><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select>
                <textarea class="textarea mono" name="token" rows="3" placeholder="Paste the access token" required></textarea>
                <button class="btn btn-primary" type="submit" style="align-self:flex-start">Connect</button>
              </form>
            </div>
            <div x-show="tg" x-cloak class="card" style="margin-bottom:1.5rem">
              <p class="muted" style="margin-bottom:.5rem">In Telegram, message <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> → <code>/newbot</code> → copy the bot token (it looks like <code>1234567890:AA…</code>, not your password). We register the webhook for you.</p>
              <form hx-post="/channels/telegram/connect" hx-ext="json-enc" hx-target="#channels-list" hx-swap="innerHTML" class="stack">
                <input class="input mono" name="token" placeholder="123456789:AA..." required />
                <button class="btn btn-primary" type="submit" style="align-self:flex-start">Connect Telegram</button>
              </form>
            </div>
          </div>
          <div id="channels-list">${renderChannels(channels)}</div>
        </div>`,
      ),
    );
  });

  app.delete("/channels/:id", guard, async (c) => {
    const id = c.req.param("id");
    const res = await channel.DELETE(c.req.raw, { params: Promise.resolve({ channelId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderChannels(await loadChannels(a.workspaceId), await noticeFrom(res, "Could not disconnect the channel.")));
  });

  app.post("/channels/:id/drain", guard, async (c) => {
    const id = c.req.param("id");
    const res = await channelDrain.POST(c.req.raw, { params: Promise.resolve({ channelId: id }) }).catch(() => null);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderChannels(await loadChannels(a.workspaceId), await noticeFrom(res, "Could not retry held messages.")));
  });

  app.post("/channels/connect-token", guard, async (c) => {
    const res = await channelConnectToken.POST(c.req.raw);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const list = renderChannels(await loadChannels(a.workspaceId));
    if (res.status >= 400) {
      const body = await res.json().catch(() => ({}));
      return c.html(html`<div class="notice notice-err">${body?.error?.message ?? "Could not connect with this token."}</div>${list}`);
    }
    return c.html(list);
  });

  app.post("/channels/telegram/connect", guard, async (c) => {
    const res = await channelTelegram.POST(c.req.raw);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const list = renderChannels(await loadChannels(a.workspaceId));
    if (res.status >= 400) {
      const body = await res.json().catch(() => ({}));
      return c.html(html`<div class="notice notice-err">${body?.error?.message ?? "Could not connect the Telegram bot."}</div>${list}`);
    }
    return c.html(list);
  });

  // Contacts
  app.get("/contacts", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    return c.html(
      dashboardDoc(
        "Contacts · ReplyStack",
        "/contacts",
        html`<div class="page" style="max-width:900px">
          <h1>Contacts</h1>
          <p class="muted">Everyone who has messaged your connected pages.</p>
          <input class="input" style="max-width:400px;margin:1rem 0" type="search" name="q" placeholder="Search by name, email, username..."
            hx-get="/contacts/list" hx-trigger="keyup changed delay:300ms, search" hx-target="#contacts-list" hx-swap="innerHTML" />
          <div id="contacts-list">${renderContacts(await loadContacts(a.workspaceId, ""))}</div>
        </div>`,
      ),
    );
  });

  app.get("/contacts/list", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const q = c.req.query("q") ?? "";
    // "Load more" grows the page (capped) so a workspace with >50 contacts is browsable.
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 50), 1000);
    return c.html(renderContacts(await loadContacts(a.workspaceId, q, limit), q, limit));
  });

  // Settings
  app.get("/settings", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const [keys, workspace] = await Promise.all([
      loadKeys(a.workspaceId),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, a.workspaceId), columns: { message_retention_days: true } }),
    ]);
    return c.html(
      dashboardDoc(
        "Settings · ReplyStack",
        "/settings",
        html`<div class="page">
          <h1>Settings</h1>
          <p class="muted">Manage your workspace settings and API access.</p>
          <section class="section">
            <h2>API Keys</h2>
            <p class="muted" style="margin-bottom:1rem">Keys are shown once on creation — store them securely.</p>
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
            <div id="keys-area">${renderKeys(keys)}</div>
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
            <h2>Webhook</h2>
            <p class="muted" style="margin-bottom:.5rem">Configure the Meta webhook to receive messages and comments.</p>
            <div class="card mono">${env.APP_URL}/api/webhooks/meta</div>
          </section>
        </div>`,
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

  // Rules
  app.get("/rules", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    return c.html(
      dashboardDoc(
        "Rules · ReplyStack",
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
                </select>
              </div>
              <div x-show="triggerType !== 'postback'"><label class="label">Keywords (comma-separated)</label><input class="input" name="keywords" placeholder="hello, hi, info" /></div>
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
                  <option value="follow_gate">Follow-gate (unlock only after they follow)</option>
                </select>
              </div>

              <!-- Follow-gate branches -->
              <div x-show="responseMode === 'follow_gate'" class="stack">
                <p class="muted" style="font-size:.75rem">Use with a Button-tap trigger. On each tap we check if they follow you, then send one of these. Instagram only.</p>
                <div><label class="label">When they follow — final message (e.g. your resource link)</label><textarea class="textarea" name="followed_text" rows="2"></textarea></div>
                <div><label class="label">When they don't follow yet — re-prompt message</label><textarea class="textarea" name="not_followed_text" rows="2" placeholder="Follow us first, then tap again 🙏"></textarea></div>
                <div><label class="label">Re-prompt button label</label><input class="input" name="claim_label" maxlength="20" placeholder="Chcę odebrać" /></div>
              </div>

              <div x-show="responseMode === 'text'"><label class="label">Reply text (DM / fallback)</label><textarea class="textarea" name="text" rows="2"></textarea></div>
              <div x-show="responseMode === 'text' && triggerType === 'comment_keyword'"><label class="label">Public comment reply text (optional)</label><input class="input" name="comment_reply_text" /></div>

              <div x-show="responseMode === 'text'">
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
              </div>

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
    const triggerType = ["comment_keyword", "postback"].includes(form.trigger_type) ? form.trigger_type : "keyword";
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

  // Approvals (human-in-the-loop review queue)
  app.get("/approvals", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    return c.html(
      dashboardDoc(
        "Approvals · ReplyStack",
        "/approvals",
        html`<div class="page">
          <h1>Approvals</h1>
          <p class="muted">Replies from rules marked “hold for approval” wait here. Approve to send, or reject to discard.</p>
          <div id="approvals-list">${renderApprovals(await loadApprovals(a.workspaceId))}</div>
        </div>`,
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

  // Sequences
  app.get("/sequences", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    return c.html(
      dashboardDoc(
        "Sequences · ReplyStack",
        "/sequences",
        html`<div class="page">
          <h1>Sequences</h1>
          <p class="muted">Automated drip message sequences. Each line below becomes a message step.</p>
          <details class="card" style="margin:1rem 0">
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
          </details>
          <div id="sequences-list">${renderSequences(await loadSequences(a.workspaceId))}</div>
        </div>`,
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

function loadContacts(workspaceId: string, q: string, limit = 50) {
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
  return db.query.contacts.findMany({
    where: and(...conds),
    orderBy: desc(contacts.last_interaction_at),
    limit,
    columns: { id: true, display_name: true, email: true, is_subscribed: true, last_interaction_at: true },
    with: {
      contact_channels: {
        columns: { platform_sender_id: true, platform_username: true },
        limit: 3,
        with: { channel: { columns: { platform: true } } },
      },
    },
  });
}

function renderContacts(contacts: Awaited<ReturnType<typeof loadContacts>>, q = "", limit = 50): Html {
  if (contacts.length === 0) {
    return html`<p class="muted">${q ? "No contacts match your search." : "No contacts yet. Connect a channel and start receiving messages."}</p>`;
  }
  // A full page likely has more — offer to load the next batch by re-rendering with a larger limit
  // (the list was previously capped at 50 with no way to browse the rest).
  const more = contacts.length >= limit
    ? html`<button class="btn btn-sm" style="margin-top:.5rem" hx-get="/contacts/list?q=${encodeURIComponent(q)}&limit=${limit + 50}" hx-target="#contacts-list" hx-swap="innerHTML">Load more</button>`
    : html``;
  return html`<table><thead><tr><th>Contact</th><th>Channels</th><th>Last seen</th></tr></thead><tbody>
    ${contacts.map(
      (ct) => html`<tr>
        <td>${ct.display_name ?? ct.contact_channels[0]?.platform_username ?? ct.contact_channels[0]?.platform_sender_id ?? "Unknown"}${ct.email ? html`<div class="muted" style="font-size:.75rem">${ct.email}</div>` : html``}${!ct.is_subscribed ? html`<div class="error" style="font-size:.7rem">Unsubscribed</div>` : html``}</td>
        <td>${ct.contact_channels.map((cc) => html`<span class="badge" style="background:var(--muted);color:var(--muted-foreground);border:1px solid var(--border);margin-right:.25rem">${(PLATFORM_LABELS[cc.channel.platform] ?? cc.channel.platform).slice(0, 2).toUpperCase()}</span>`)}</td>
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
      <button class="btn btn-sm" hx-post="/rules/${r.id}/toggle" hx-target="#rules-list" hx-swap="innerHTML">${r.is_active ? "Pause" : "Activate"}</button>
      <button class="btn btn-sm btn-danger" hx-delete="/rules/${r.id}" hx-target="#rules-list" hx-swap="innerHTML" hx-confirm="Delete this rule?">Delete</button>
    </div>`,
  )}</div>`;
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
