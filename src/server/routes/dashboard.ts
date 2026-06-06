import type { Hono, MiddlewareHandler, Context } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { prisma } from "@/lib/prisma";
import { authenticate, type AuthContext } from "@/lib/auth";
import { env } from "@/lib/env";
import * as channel from "@/server/handlers/v1/channels/[channelId]/route";
import * as channelDrain from "@/server/handlers/v1/channels/[channelId]/drain/route";
import * as channelConnectToken from "@/server/handlers/v1/channels/connect-token/route";
import * as conversationMessages from "@/server/handlers/v1/conversations/[conversationId]/messages/route";
import * as rules from "@/server/handlers/v1/rules/route";
import * as rule from "@/server/handlers/v1/rules/[ruleId]/route";
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

const CONV_SELECT = {
  id: true, platform: true, status: true, last_message_at: true,
  last_message_preview: true, unread_count: true,
  channel: { select: { id: true, display_name: true, platform: true } },
  contact: {
    select: {
      id: true, display_name: true, avatar_url: true,
      contact_channels: { select: { platform_sender_id: true, platform_username: true }, take: 1 },
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

function renderThread(conv: ConvName & { id: string; channel: { display_name: string | null; platform: string } }, messages: Array<{ id: string; direction: string; text: string | null }>): Html {
  return html`<div class="thread-head">${contactName(conv)} <span class="muted">via ${conv.channel.display_name ?? conv.channel.platform}</span></div>
    <div id="thread-msgs" class="thread-msgs" hx-get="/inbox/${conv.id}/messages" hx-trigger="every 5s" hx-swap="innerHTML">${renderMessages(messages)}</div>
    <form class="reply-bar" hx-post="/inbox/${conv.id}/reply" hx-ext="json-enc" hx-target="#thread" hx-swap="innerHTML">
      <textarea class="textarea" name="text" rows="2" placeholder="Type a reply..." required></textarea>
      <button class="btn btn-primary" type="submit">Send</button>
    </form>`;
}

function loadConversations(workspaceId: string) {
  return prisma.conversation.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { last_message_at: "desc" },
    take: 50,
    select: CONV_SELECT,
  });
}

function loadMessages(conversationId: string) {
  return prisma.message
    .findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: "desc" },
      take: 50,
      select: { id: true, direction: true, text: true, created_at: true },
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
  const channels = await prisma.channel.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { created_at: "asc" },
    select: {
      id: true, platform: true, platform_id: true, display_name: true, username: true,
      profile_picture: true, status: true, connection_mode: true,
    },
  });
  return Promise.all(
    channels.map(async (ch) => ({
      ...ch,
      held_count: await prisma.message.count({ where: { status: "held", conversation: { channel_id: ch.id } } }),
    })),
  );
}

function renderChannels(channels: Awaited<ReturnType<typeof loadChannels>>): Html {
  if (channels.length === 0) return html`<p class="muted">No channels connected yet.</p>`;
  return html`<div class="list">${channels.map(
    (ch) => html`<div class="list-row">
      ${ch.profile_picture ? html`<img class="avatar" src="${ch.profile_picture}" alt="" />` : html``}
      <div class="grow">
        <div style="font-weight:600">${ch.display_name ?? ch.username ?? ch.platform_id}</div>
        <div class="muted" style="font-size:.75rem">
          ${PLATFORM_LABELS[ch.platform] ?? ch.platform}${ch.username ? ` · @${ch.username}` : ""}${ch.status === "needs_reauth" ? " · ⚠ Needs reconnect" : ""}${ch.status === "paused" ? " · Paused" : ""}${ch.status === "disabled" ? " · Disabled" : ""}${ch.connection_mode === "manual_token" ? " · 🔑 Long-lived token" : ""}${ch.held_count > 0 ? ` · ${ch.held_count} held` : ""}
        </div>
      </div>
      ${ch.held_count > 0 ? html`<button class="btn btn-sm" hx-post="/channels/${ch.id}/drain" hx-target="#channels-list" hx-swap="innerHTML">↻ Retry held</button>` : html``}
      <button class="btn btn-sm" hx-delete="/channels/${ch.id}" hx-target="#channels-list" hx-swap="innerHTML" hx-confirm="Disconnect this channel? Auto-replies will stop for this account.">Disconnect</button>
    </div>`,
  )}</div>`;
}

// ─── registration ─────────────────────────────────────────────────────────────

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
    const conv = await prisma.conversation.findFirst({ where: { id, workspace_id: a.workspaceId }, select: CONV_SELECT });
    if (!conv) return c.notFound();
    await prisma.conversation.update({ where: { id }, data: { unread_count: 0 } }).catch(() => {});
    const messages = await loadMessages(id);
    return c.html(renderThread(conv, messages));
  });

  app.get("/inbox/:id/messages", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    const conv = await prisma.conversation.findFirst({ where: { id, workspace_id: a.workspaceId }, select: { id: true } });
    if (!conv) return c.notFound();
    return c.html(renderMessages(await loadMessages(id)));
  });

  app.post("/inbox/:id/reply", guard, async (c) => {
    const id = c.req.param("id");
    await conversationMessages.POST(c.req.raw, { params: Promise.resolve({ conversationId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const conv = await prisma.conversation.findFirst({ where: { id, workspace_id: a.workspaceId }, select: CONV_SELECT });
    if (!conv) return c.notFound();
    return c.html(renderThread(conv, await loadMessages(id)));
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
          <div x-data="{ token: false }">
            <div class="row" style="margin:1rem 0 1rem">
              <a class="btn" style="background:#1877f2;color:#fff;border:none" href="/api/oauth/facebook">+ Facebook</a>
              <a class="btn" style="background:#bc1888;color:#fff;border:none" href="/api/oauth/instagram">+ Instagram</a>
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
          </div>
          <div id="channels-list">${renderChannels(channels)}</div>
        </div>`,
      ),
    );
  });

  app.delete("/channels/:id", guard, async (c) => {
    const id = c.req.param("id");
    await channel.DELETE(c.req.raw, { params: Promise.resolve({ channelId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderChannels(await loadChannels(a.workspaceId)));
  });

  app.post("/channels/:id/drain", guard, async (c) => {
    const id = c.req.param("id");
    await channelDrain.POST(c.req.raw, { params: Promise.resolve({ channelId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderChannels(await loadChannels(a.workspaceId)));
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
    return c.html(renderContacts(await loadContacts(a.workspaceId, q), q));
  });

  // Settings
  app.get("/settings", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const [keys, workspace] = await Promise.all([
      prisma.apiKey.findMany({
        where: { workspace_id: a.workspaceId },
        orderBy: { created_at: "desc" },
        select: { id: true, name: true, key_prefix: true, last_used_at: true, expires_at: true },
      }),
      prisma.workspace.findUnique({ where: { id: a.workspaceId }, select: { message_retention_days: true } }),
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
            <form hx-post="/settings/api-keys" hx-ext="json-enc" hx-target="#keys-area" hx-swap="innerHTML" class="row" style="margin-bottom:1rem">
              <input class="input" name="name" placeholder="Key name (e.g. Production webhook)" required />
              <button class="btn btn-primary" type="submit">Create</button>
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
    const res = await apiKeys.POST(c.req.raw);
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const body = await res.json().catch(() => ({}));
    const keys = await prisma.apiKey.findMany({
      where: { workspace_id: a.workspaceId },
      orderBy: { created_at: "desc" },
      select: { id: true, name: true, key_prefix: true, last_used_at: true, expires_at: true },
    });
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
    await apiKey.DELETE(c.req.raw, { params: Promise.resolve({ keyId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const keys = await prisma.apiKey.findMany({
      where: { workspace_id: a.workspaceId },
      orderBy: { created_at: "desc" },
      select: { id: true, name: true, key_prefix: true, last_used_at: true, expires_at: true },
    });
    return c.html(renderKeys(keys));
  });

  app.post("/settings/retention", guard, async (c) => {
    const form = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const rawDays = (form as Record<string, unknown>).message_retention_days;
    const days = rawDays === "" || rawDays == null ? null : Number(rawDays);
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
          <p class="muted">Keyword auto-replies. The API supports richer triggers; this form covers the common keyword → text reply.</p>
          <details class="card" style="margin:1rem 0">
            <summary style="cursor:pointer;font-weight:600">+ New keyword rule</summary>
            <form hx-post="/rules" hx-ext="json-enc" hx-target="#rules-list" hx-swap="innerHTML" class="stack" style="margin-top:.75rem">
              <div><label class="label">Name</label><input class="input" name="name" required /></div>
              <div><label class="label">Keywords (comma-separated)</label><input class="input" name="keywords" placeholder="hello, hi, info" required /></div>
              <div><label class="label">Reply text</label><textarea class="textarea" name="text" rows="2" required></textarea></div>
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
    const payload = {
      name: form.name ?? "",
      trigger_type: "keyword",
      trigger_config: { keywords },
      response_type: "text",
      response_config: { text: form.text ?? "" },
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
    const existing = await prisma.autoReplyRule.findFirst({ where: { id, workspace_id: a.workspaceId }, select: { is_active: true } });
    if (existing) {
      await rule.PATCH(jsonReqMethod(c, "PATCH", { is_active: !existing.is_active }), { params: Promise.resolve({ ruleId: id }) }).catch(() => {});
    }
    return c.html(renderRules(await loadRules(a.workspaceId)));
  });

  app.delete("/rules/:id", guard, async (c) => {
    const id = c.req.param("id");
    await rule.DELETE(c.req.raw, { params: Promise.resolve({ ruleId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderRules(await loadRules(a.workspaceId)));
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
            <form hx-post="/sequences" hx-ext="json-enc" hx-target="#sequences-list" hx-swap="innerHTML" class="stack" style="margin-top:.75rem">
              <div><label class="label">Name</label><input class="input" name="name" required /></div>
              <div><label class="label">Description</label><input class="input" name="description" /></div>
              <div><label class="label">Message steps (one per line)</label><textarea class="textarea" name="steps" rows="4" required></textarea></div>
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
    const steps = (form.steps ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((content) => ({ type: "message", content }));
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
    await sequence.PATCH(jsonReqMethod(c, "PATCH", { status: form.status }), { params: Promise.resolve({ sequenceId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderSequences(await loadSequences(a.workspaceId)));
  });

  app.delete("/sequences/:id", guard, async (c) => {
    const id = c.req.param("id");
    await sequence.DELETE(c.req.raw, { params: Promise.resolve({ sequenceId: id }) }).catch(() => {});
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    return c.html(renderSequences(await loadSequences(a.workspaceId)));
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
    await prisma.workspace.update({ where: { id: a.workspaceId }, data: { message_retention_days: days } });
    return true;
  } catch {
    return false;
  }
}

// ─── contacts/keys/rules/sequences renderers ──────────────────────────────────

function loadContacts(workspaceId: string, q: string) {
  const safeQ = q ? q.replace(/[%_\\]/g, "\\$&") : "";
  return prisma.contact.findMany({
    where: {
      workspace_id: workspaceId,
      ...(safeQ
        ? {
            OR: [
              { display_name: { contains: safeQ, mode: "insensitive" } },
              { email: { contains: safeQ, mode: "insensitive" } },
              { contact_channels: { some: { OR: [{ platform_username: { contains: safeQ, mode: "insensitive" } }, { platform_sender_id: { contains: safeQ } }] } } },
            ],
          }
        : {}),
    },
    orderBy: { last_interaction_at: "desc" },
    take: 50,
    select: {
      id: true, display_name: true, email: true, is_subscribed: true, last_interaction_at: true,
      contact_channels: { select: { platform_sender_id: true, platform_username: true, channel: { select: { platform: true } } }, take: 3 },
    },
  });
}

function renderContacts(contacts: Awaited<ReturnType<typeof loadContacts>>, q = ""): Html {
  if (contacts.length === 0) {
    return html`<p class="muted">${q ? "No contacts match your search." : "No contacts yet. Connect a channel and start receiving messages."}</p>`;
  }
  return html`<table><thead><tr><th>Contact</th><th>Channels</th><th>Last seen</th></tr></thead><tbody>
    ${contacts.map(
      (ct) => html`<tr>
        <td>${ct.display_name ?? ct.contact_channels[0]?.platform_username ?? ct.contact_channels[0]?.platform_sender_id ?? "Unknown"}${ct.email ? html`<div class="muted" style="font-size:.75rem">${ct.email}</div>` : html``}${!ct.is_subscribed ? html`<div class="error" style="font-size:.7rem">Unsubscribed</div>` : html``}</td>
        <td>${ct.contact_channels.map((cc) => html`<span class="badge" style="background:var(--muted);color:var(--muted-foreground);border:1px solid var(--border);margin-right:.25rem">${(PLATFORM_LABELS[cc.channel.platform] ?? cc.channel.platform).slice(0, 2).toUpperCase()}</span>`)}</td>
        <td class="muted">${timeAgo(ct.last_interaction_at)}</td>
      </tr>`,
    )}
  </tbody></table>`;
}

function renderKeys(keys: Array<{ id: string; name: string; key_prefix: string; last_used_at: Date | null; expires_at: Date | null }>): Html {
  if (keys.length === 0) return html`<p class="muted">No API keys yet.</p>`;
  return html`<table><thead><tr><th>Name</th><th>Last used</th><th>Expiry</th><th></th></tr></thead><tbody>
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

function loadRules(workspaceId: string) {
  return prisma.autoReplyRule.findMany({
    where: { workspace_id: workspaceId },
    orderBy: [{ priority: "desc" }, { created_at: "asc" }],
    take: 200,
    select: { id: true, name: true, is_active: true, trigger_type: true, response_type: true },
  });
}

function renderRules(rulesList: Awaited<ReturnType<typeof loadRules>>): Html {
  if (rulesList.length === 0) return html`<p class="muted">No rules yet.</p>`;
  return html`<div class="list">${rulesList.map(
    (r) => html`<div class="list-row">
      <div class="grow"><span style="font-weight:600">${r.name}</span> <span class="muted" style="font-size:.75rem">${r.trigger_type} → ${r.response_type}${r.is_active ? "" : " · inactive"}</span></div>
      <button class="btn btn-sm" hx-post="/rules/${r.id}/toggle" hx-target="#rules-list" hx-swap="innerHTML">${r.is_active ? "Pause" : "Activate"}</button>
      <button class="btn btn-sm btn-danger" hx-delete="/rules/${r.id}" hx-target="#rules-list" hx-swap="innerHTML" hx-confirm="Delete this rule?">Delete</button>
    </div>`,
  )}</div>`;
}

function loadSequences(workspaceId: string) {
  return prisma.sequence.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { created_at: "desc" },
    select: { id: true, name: true, status: true, steps: true, _count: { select: { enrollments: true } } },
  });
}

function renderSequences(seqs: Awaited<ReturnType<typeof loadSequences>>): Html {
  if (seqs.length === 0) return html`<p class="muted">No sequences yet.</p>`;
  return html`<div class="list">${seqs.map((seq) => {
    const stepCount = Array.isArray(seq.steps) ? seq.steps.length : 0;
    return html`<div class="list-row">
      <div class="grow"><span style="font-weight:600">${seq.name}</span> <span class="muted" style="font-size:.75rem">${seq.status.toUpperCase()} · ${stepCount} steps · ${seq._count.enrollments} enrolled</span></div>
      ${seq.status === "draft" ? html`<button class="btn btn-sm" hx-post="/sequences/${seq.id}/status" hx-ext="json-enc" hx-vals='{"status":"active"}' hx-target="#sequences-list" hx-swap="innerHTML">Activate</button>` : html``}
      ${seq.status === "active" ? html`<button class="btn btn-sm" hx-post="/sequences/${seq.id}/status" hx-ext="json-enc" hx-vals='{"status":"archived"}' hx-target="#sequences-list" hx-swap="innerHTML">Archive</button>` : html``}
      <button class="btn btn-sm btn-danger" hx-delete="/sequences/${seq.id}" hx-target="#sequences-list" hx-swap="innerHTML" hx-confirm="Delete this sequence?">Delete</button>
    </div>`;
  })}</div>`;
}
