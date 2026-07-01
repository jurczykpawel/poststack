import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { desc, eq, and, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { events as eventsTbl, conversations as conversationsTbl, messages as messagesTbl, commentLogs as commentLogsTbl, deliveries as deliveriesTbl } from "@/db/schema";
import { authenticate, type AuthContext } from "@/lib/auth";
import {
  listChannels,
  getChannel,
  getChannelRateState,
  reconnectManualToken,
  setChannelStatus,
  setChannelDisplayName,
  setChannelDefaultFirstComment,
  setChannelDefaultAutoStory,
  setChannelHidden,
  setChannelGmailQuery,
  setChannelAiDraftSettings,
  isAiDraftTarget,
  deleteChannel,
  runHealthCheck,
  isChannelSort,
  CHANNEL_STATUSES,
  type ChannelSort,
  type ChannelStatus,
  type PublicChannel,
} from "@/lib/channels/service";
import { can } from "@/lib/channels/capabilities";
import { getProvider } from "@/lib/platforms/registry";
import { getProviderForPlatform } from "@/lib/providers";
import { DEFAULT_DRAFT_PROMPT } from "@/lib/ai/draft";
import { isAiConfigured } from "@/lib/ai/client";
import { aiUnconfiguredBanner } from "../components/ai-notice";
import type { Platform } from "@/db/schema";
import { listDeliveries } from "@/lib/deliveries/service";
import { listBrands, assignChannelBrand, type BrandRow } from "@/lib/brands/service";
import { ApiError } from "@/lib/api/response";
import { getInstanceLicense, hasFeature } from "@/lib/license/gate";
import { proMessage, type Feature } from "@/lib/license/features";
import { env } from "@/lib/env";
import { renderPage } from "../layout";
import { statusBadge, pill, dot, type Tone } from "../components/status";
import { platformCell, platformLabel, platformColor, platformGlyph } from "../components/platform";
import { btn } from "../components/button";
import { icon } from "../components/icons";
import { reconnectHref } from "../components/reconnect";
import { relTime, fmtDate } from "../components/format";
import { isHtmx, toastHeader, type ToastTone } from "../components/toast";

type Html = ReturnType<typeof html>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_WARN_DAYS = Number(process.env.CHANNEL_TOKEN_WARN_DAYS ?? 7);

const STATUS_META: Record<ChannelStatus, { label: string; tone: Tone }> = {
  active: { label: "Healthy", tone: "ok" },
  needs_reauth: { label: "Needs reauth", tone: "warn" },
  paused: { label: "Paused", tone: "neutral" },
  disabled: { label: "Disabled", tone: "neutral" },
};

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

// ── capability badges (CHANNELS-ARCHITECTURE: a channel is an account WITH capabilities) ─────────
const CAP_LABEL: { cap: Parameters<typeof can>[1]; label: string }[] = [
  { cap: "publish", label: "publish" },
  { cap: "comment_reply", label: "reply" },
  { cap: "dm", label: "DM" },
  { cap: "poll_comments", label: "poll" },
];
export function capabilityBadges(ch: PublicChannel): Html {
  const ctx = { platform: ch.platform, connection_mode: ch.connection_mode, metadata: ch.metadata };
  let on = CAP_LABEL.filter((c) => can(ctx, c.cap));
  // A13: a `facebook_only` IG channel cannot reliably RECEIVE DMs at Standard Access (see messagingHint),
  // so the structural "DM" capability pill is misleading here — drop it. UI-only: the structural
  // `channelCapabilities` and the REST `capabilities` array are unchanged (API consumers get the full
  // structural caps + `messaging_connection` to interpret).
  if (ch.messaging_connection === "facebook_only") on = on.filter((c) => c.cap !== "dm");
  if (on.length === 0) return html`<small>—</small>`;
  return html`<span class="pill-row">${on.map((c) => pill(c.label, "info"))}</span>`;
}

// ── IG messaging connection visibility (IGML: "make it visible when/what works") ─────────────────
/** B1/B4: which token powers messaging on an IG channel — `Instagram Login` (reliable DMs at
 *  Standard Access) vs `Facebook only` (DMs not guaranteed). Empty for non-IG channels (null). */
export function messagingConnectionBadge(ch: PublicChannel): Html {
  if (ch.messaging_connection === "instagram_login") return pill("Instagram Login", "info");
  if (ch.messaging_connection === "facebook_only") return pill("Facebook only", "neutral");
  return html``;
}

/** B2: a per-channel capability note, rendered for BOTH messaging-connection states. A
 *  `facebook_only` IG channel publishes/comments but won't receive IG DMs at the access level
 *  self-hosters use, so nudge the operator to connect Instagram Login; an `instagram_login`
 *  channel is a full standalone connection, so reassure that DMs/comments/publishing all work and
 *  that each account is connected individually. Empty for non-IG / unset channels. */
export function messagingHint(ch: PublicChannel): Html {
  if (ch.messaging_connection === "facebook_only")
    return html`<div class="notice notice-warn">
      Publishing and comments are active. Instagram <strong>direct messages</strong> aren't delivered on the Facebook connection —
      <a href="/api/oauth/instagram-login">connect Instagram Login</a> to receive and reply to DMs.
    </div>`;
  if (ch.messaging_connection === "instagram_login")
    return html`<div class="notice notice-info">
      Full Instagram connection — direct messages, comments and publishing are active for this account. Each Instagram account is connected individually.
    </div>`;
  return html``;
}

/** B3: surface the last recorded error so a degraded-but-still-"active" channel (e.g. the IG
 *  messaging webhook subscribe that failed silently) isn't invisible. Reuses the `bad` pill tone —
 *  no parallel status-label map. Empty when there's no error. */
export function lastErrorNote(ch: PublicChannel): Html {
  if (!ch.last_error) return html``;
  return html`<div class="ch-last-error">${pill("last error", "bad")} <small>${ch.last_error}</small></div>`;
}

/** A2: in-panel guide for connecting Instagram, surfaced near the "+ Instagram (messaging)" button.
 *  Explains the two-path connection model (Instagram has a real asymmetry Facebook doesn't): a full
 *  standalone **Instagram Login** vs the bulk **Facebook Login / managed connection**, *when* to use
 *  each, why DMs don't arrive on a Facebook connection (Meta's **Advanced Access** / App Review), how
 *  to spot an account missing DMs (the `Facebook only` badge), and that PRO features stay PRO
 *  regardless of connection method. Includes a durable self-host Meta-app setup walkthrough as a
 *  visually subordinate nested sub-section. Reuses the `guide-*`/`notice-*` styling + `pill`; UI-only. */
export function instagramLoginInstructions(): Html {
  const redirectUri = `${env.APP_URL.replace(/\/$/, "")}/api/oauth/instagram-login/callback`;
  return html`<details class="guide-panel" style="margin-top:.75rem">
    <summary class="guide-summary">Connecting Instagram — what works, and when ${pill("setup", "info")}</summary>
    <div class="guide-body">
      <p>There are two ways to connect Instagram, and they have different capabilities:</p>
      <ul class="guide-steps">
        <li>
          <strong>Instagram Login</strong> (the "+ Instagram (messaging)" button): a full standalone
          connection for <strong>one</strong> Instagram account — supporting
          <strong>publishing, comments, direct messages, and follow-gate</strong> — and it
          <strong>does not require a Facebook page</strong>. You connect each account individually.
        </li>
        <li>
          <strong>Facebook Login</strong> (or a managed connection): bulk-connects
          <strong>all</strong> linked Instagram accounts at once — but only
          <strong>publishing and comments</strong>. Instagram <strong>direct messages</strong> are
          not delivered this way at the access level self-hosters use — that would need Meta's
          <strong>Advanced Access</strong> (a full App Review), which most self-hosters skip.
        </li>
      </ul>
      <p>When to use which:</p>
      <ul class="guide-steps">
        <li>One or a few accounts, want everything (especially DMs): just use
          <strong>Instagram Login</strong> — nothing else needed.</li>
        <li>Many accounts, mainly publishing: bulk-connect via
          <strong>Facebook Login / a managed connection</strong>, then add
          <strong>Instagram Login</strong> on the accounts where you want DMs.</li>
      </ul>
      <p>
        <strong>Connected but DMs don't work?</strong> A channel showing the
        <strong>"Facebook only"</strong> badge means its DM webhooks won't arrive — click
        <strong>"+ Instagram (messaging)"</strong> on that account to enable
        <strong>direct messages</strong>.
      </p>
      <div class="notice notice-info">
        <strong>PRO</strong> features (follow-gate, drip sequences, manual replies, Auto-Story,
        automatic first comment, …) require a PRO license
        <strong>regardless of how the account is connected</strong> — Instagram Login does not unlock
        them for free.
      </div>
      <details class="guide-panel" style="margin-top:.75rem">
        <summary class="guide-summary">Self-host setup: configuring the Meta app ${pill("self-host setup", "info")}</summary>
        <div class="guide-body">
          <p>Instagram Business Login needs your own Meta app:</p>
          <ol class="guide-steps">
            <li>Create a Meta app at <strong>developers.facebook.com</strong> and add the
              <strong>Instagram</strong> product → <strong>API setup with Instagram login</strong>
              (this is what enables Instagram Business Login).</li>
            <li>Set <code>INSTAGRAM_APP_ID</code> and <code>INSTAGRAM_APP_SECRET</code> from that
              Instagram product. <strong>Note:</strong> these are the <strong>Instagram</strong> app
              id/secret — different from the Facebook app's <code>META_APP_ID</code>/<code>META_APP_SECRET</code>.</li>
            <li>Register this OAuth redirect URI in the Instagram Login settings: <code>${redirectUri}</code></li>
            <li>The Instagram account must be a <strong>Business or Creator</strong> account, with
              message access allowed for connected tools <em>(Meta moves this setting around — if you
              can't find it, search Instagram Help for "allow access to messages")</em>.</li>
          </ol>
          <p class="guide-note">Connecting subscribes that account to messaging webhooks automatically (per-account) — no extra step.</p>
        </div>
      </details>
    </div>
  </details>`;
}

/** The per-row reconnect action — only shown on a channel that actually needs it. */
function reauthAction(ch: PublicChannel): Html {
  if (ch.status !== "needs_reauth") return html`<small>—</small>`;
  // reconnectHref is the single source of truth for the destination (incl. IG-Login awareness);
  // this section only varies the label/markup per connection mode.
  const href = reconnectHref(ch);
  if (ch.connection_mode === "derived") return html`<a href="${href}">Reconnect master →</a>`;
  if (ch.connection_mode === "oauth") return html`<a class="act" role="button" href="${href}">Reconnect</a>`;
  // manual_token → reconnect on the detail page (paste a fresh token).
  return html`<a class="act outline" role="button" href="${href}">Reconnect →</a>`;
}

function countsHeader(
  byStatus: Record<ChannelStatus, number>,
  byPlatform: Record<string, number>,
  active: { status?: string; platform?: string; showHidden?: boolean },
  hiddenCount: number,
): Html {
  const statusChips = CHANNEL_STATUSES.map((s) => {
    const meta = STATUS_META[s];
    const on = active.status === s;
    const href = on ? "/channels" : `/channels?status=${s}`;
    return html`<a class="count-chip ${on ? "is-on" : ""}" href="${href}">
      ${pill(meta.label, meta.tone)}<span class="count-n">${byStatus[s]}</span>
    </a>`;
  });
  const platformBits = Object.entries(byPlatform)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => {
      const on = active.platform === p;
      const href = on ? "/channels" : `/channels?platform=${p}`;
      return html`<a class="count-plat ${on ? "is-on" : ""}" href="${href}">${platformLabel(p)} <b>${n}</b></a>`;
    });
  const hiddenChip = hiddenCount > 0 || active.showHidden
    ? html`<a class="count-plat${active.showHidden ? " is-on" : ""}" href="${active.showHidden ? "/channels" : "/channels?showHidden=1"}">
        Hidden <b>${hiddenCount}</b>
      </a>`
    : "";
  return html`<div class="counts-bar">
    <div class="counts-status">${statusChips}</div>
    ${platformBits.length || hiddenChip ? html`<div class="counts-plat">${platformBits}${hiddenChip}</div>` : ""}
  </div>`;
}

function filterBar(
  platforms: string[],
  active: { platform?: string; status?: string; q?: string; sort: ChannelSort; showHidden?: boolean },
): Html {
  const platformOpts = platforms.map(
    (p) => html`<option value="${p}"${active.platform === p ? raw(" selected") : raw("")}>${platformLabel(p)}</option>`,
  );
  const statusOpts = CHANNEL_STATUSES.map(
    (s) => html`<option value="${s}"${active.status === s ? raw(" selected") : raw("")}>${STATUS_META[s].label}</option>`,
  );
  const sortOpts = SORT_LABELS.map(
    ([v, label]) => html`<option value="${v}"${active.sort === v ? raw(" selected") : raw("")}>${label}</option>`,
  );
  const hiddenField = active.showHidden ? html`<input type="hidden" name="showHidden" value="1" />` : "";
  const hasFilters = !!(active.platform || active.status || active.q || active.sort !== "recent");
  return html`<form class="filter-bar" method="get" action="/channels" role="search">
    <div class="filter-search">
      <svg class="ico" width="15" height="15" aria-hidden="true"><use href="#i-search" /></svg>
      <input type="search" name="q" value="${active.q ?? ""}" placeholder="Search name or account id" aria-label="Search channels" />
    </div>
    <select name="platform" aria-label="Filter by platform">
      <option value="">All platforms</option>
      ${platformOpts}
    </select>
    <select name="status" aria-label="Filter by status">
      <option value="">All statuses</option>
      ${statusOpts}
    </select>
    <select name="sort" aria-label="Sort channels">${sortOpts}</select>
    ${hiddenField}
    <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
    ${hasFilters ? html`<a class="filter-clear" href="${active.showHidden ? "/channels?showHidden=1" : "/channels"}">Clear</a>` : ""}
  </form>`;
}

const SORT_LABELS: [ChannelSort, string][] = [
  ["recent", "Newest"],
  ["name", "Name"],
  ["status", "Status"],
  ["platform", "Platform"],
];

/** Per-row brand assignment select (htmx PUT; toast only — the group regroups on reload). */
function brandSelect(ch: PublicChannel, brands: BrandRow[]): Html {
  const opts = brands.map(
    (b) => html`<option value="${b.key}"${ch.brand_key === b.key ? raw(" selected") : raw("")}>${b.name}</option>`,
  );
  return html`<select class="brand-assign" name="brandKey" aria-label="Assign brand"
    hx-put="/channels/${ch.id}/brand" hx-target="this" hx-swap="none">
    <option value=""${!ch.brand_key ? raw(" selected") : raw("")}>— unassigned —</option>
    ${opts}
  </select>`;
}

function channelAvatar(ch: PublicChannel): string | undefined {
  return ch.profile_picture ?? undefined;
}
function channelHandle(ch: PublicChannel): string | undefined {
  return ch.username ?? undefined;
}

/** The per-card primary action: reconnect when the token is stale, otherwise a quiet "Manage" link. */
function cardAction(ch: PublicChannel): Html {
  if (ch.status === "needs_reauth") return reauthAction(ch);
  return html`<a class="act outline" role="button" href="/channels/${ch.id}">Manage →</a>`;
}

function channelCard(ch: PublicChannel, brands: BrandRow[]): Html {
  const tone = STATUS_META[ch.status].tone;
  const color = platformColor(ch.platform, ch.metadata);
  const name = ch.display_name ?? ch.provider_account_id;
  const handle = channelHandle(ch);
  const handleStr = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : null;
  const handleBit = handleStr && handleStr !== ch.display_name && handleStr !== ch.provider_account_id
    ? html`<span class="acct-handle">${handleStr}</span>`
    : "";
  const idBit = ch.display_name ? html`<span class="acct-id">${ch.provider_account_id}</span>` : "";
  // Real profile picture + a small brand-glyph badge; brand-coloured glyph tile when there's no photo.
  const av = channelAvatar(ch);
  const avatar = av && av.startsWith("https://")
    ? html`<span class="conv-av"><img class="conv-av-i" src="${av}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" /><span class="conv-pg" style="background:${color}">${platformGlyph(ch.platform, 9, ch.metadata)}</span></span>`
    : html`<span class="conv-av"><span class="conv-av-i" style="background:${color}">${platformGlyph(ch.platform, 18, ch.metadata)}</span></span>`;
  return html`<article class="post-card ch-card tone-edge-${tone}">
    <a class="ch-card-head" href="/channels/${ch.id}">
      ${avatar}
      <span class="ch-meta">
        <span class="acct-name">${name}</span>
        ${handleBit}
        ${idBit}
      </span>
      ${statusBadge(ch.status)}
    </a>
    <div class="detail-sub"><span class="mode-tag">${ch.connection_mode}</span>${capabilityBadges(ch)}${messagingConnectionBadge(ch)}</div>
    ${lastErrorNote(ch)}
    <div class="ch-foot">${brandSelect(ch, brands)}<span class="ch-foot-act">${cardAction(ch)}</span></div>
  </article>`;
}

/** Group channel cards by owning brand (brands A→Z, then Unassigned). */
function channelGroups(items: PublicChannel[], brands: BrandRow[]): Html {
  const nameByKey = new Map(brands.map((b) => [b.key, b.name] as const));
  const groups = new Map<string, PublicChannel[]>();
  for (const ch of items) {
    const k = ch.brand_key ?? "";
    const arr = groups.get(k);
    if (arr) arr.push(ch);
    else groups.set(k, [ch]);
  }
  const orderedKeys = [...brands]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => b.key)
    .filter((k) => groups.has(k));
  if (groups.has("")) orderedKeys.push("");
  // A lone "Unassigned" group needs no header; brand groups always label themselves.
  const showHeads = orderedKeys.length > 1 || orderedKeys[0] !== "";
  return html`${orderedKeys.map((k) => {
    const list = groups.get(k)!;
    const label = k === "" ? "Unassigned" : (nameByKey.get(k) ?? k);
    const head = showHeads ? html`<div class="cred-subhead">${label} (${list.length})</div>` : "";
    return html`${head}<div class="card-grid">${list.map((ch) => channelCard(ch, brands))}</div>`;
  })}`;
}

const CHANNEL_ERRORS: Record<string, string> = {
  access_denied: "Access denied — you cancelled the connection.",
  no_pages: "No Facebook Pages found. Make sure you manage at least one Page.",
  no_ig_accounts: "No Instagram Business accounts found linked to your Pages.",
  oauth_failed: "Connection failed. Please try again.",
  pro_required: "That channel needs a PRO license.",
  instagram_login_not_configured:
    "Instagram Business Login isn't configured (set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET).",
};

async function channelsPage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const ws = a.workspaceId;
  const url = new URL(c.req.url);

  const platformParam = url.searchParams.get("platform") || undefined;
  const showHidden = url.searchParams.get("showHidden") === "1";
  const statusParam = url.searchParams.get("status") || undefined;
  const status = (statusParam && (CHANNEL_STATUSES as string[]).includes(statusParam) ? statusParam : undefined) as ChannelStatus | undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  const sortParam = url.searchParams.get("sort") || undefined;
  const sort: ChannelSort = isChannelSort(sortParam) ? sortParam : "recent";
  const sourceId = url.searchParams.get("sourceId") || undefined;
  const errorKey = url.searchParams.get("error") || undefined;
  const connected = url.searchParams.get("connected");
  const connectedCount = url.searchParams.get("count");

  const [{ items, countsByPlatform, countsByStatus, hiddenCount }, brands, lic] = await Promise.all([
    listChannels({ workspaceId: ws, limit: 100, platform: platformParam, status, q, sort, sourceId, showHidden }),
    listBrands(ws),
    getInstanceLicense(),
  ]);

  const platformsForFilter = Object.keys(countsByPlatform).sort();
  const totalChannels = CHANNEL_STATUSES.reduce((n, s) => n + countsByStatus[s], 0);
  const noChannels = totalChannels === 0; // truly empty workspace (vs. none matching a filter)
  const noMatch = !noChannels && items.length === 0;
  const canManaged = lic.features.has("managed_connection");
  const canMultiChannel = lic.features.has("multi_channel");
  const canNonMeta = lic.features.has("non_meta_channels");
  const upgradeUrl = lic.upgradeUrl;
  const hasFb = items.some((ch) => ch.platform === "facebook" && ch.status !== "disabled");
  const hasIg = items.some((ch) => ch.platform === "instagram" && ch.status !== "disabled");
  // A locked connect affordance: links to the upgrade page instead of connecting.
  const proConnect = (label: string) =>
    html`<a class="btn btn-secondary" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">${icon("lock", "ico", 12)} ${label} (PRO)</a>`;

  return c.html(
    renderPage({
      title: "Channels",
      nav: "channels",
      features: lic.features,
      products: lic.products,
      breadcrumb: noChannels ? "No channels yet" : sourceId ? `${items.length} shown · filtered by source` : `${items.length} shown`,
      body: html`${errorKey ? html`<div class="auth-error">${CHANNEL_ERRORS[errorKey] ?? "Something went wrong."}</div>` : ""}
        ${connected && connectedCount ? html`<div class="notice notice-ok">${connectedCount} ${platformLabel(connected)} account(s) connected.</div>` : ""}
        ${noChannels
          ? html`<section class="panel"><div class="empty">
              <span class="empty-ic">${icon("channels", "ico", 20)}</span>
              <p class="empty-title">No channels connected yet</p>
              <p class="empty-body">Connect your first Facebook Page, Instagram, YouTube, Telegram or Gmail account to start publishing and auto-replying — they’ll appear here grouped by brand.</p>
            </div></section>`
          : html`${countsHeader(countsByStatus, countsByPlatform, { status, platform: platformParam, showHidden }, hiddenCount)}
            ${filterBar(platformsForFilter, { platform: platformParam, status, q, sort, showHidden })}
            ${noMatch
              ? html`<section class="panel"><div class="empty">
                  <span class="empty-ic">${icon("search", "ico", 20)}</span>
                  <p class="empty-title">No channels match these filters</p>
                  <p class="empty-body">Try a different search, status or platform.</p>
                  <a class="btn btn-secondary" href="${showHidden ? "/channels?showHidden=1" : "/channels"}">Clear filters</a>
                </div></section>`
              : channelGroups(items, brands)}`}
        <section class="panel">
          <div class="panel-head"><h3>Connect a channel</h3></div>
          <div class="set-body">
            <p class="set-lead">Connect a Facebook Page or Instagram Business account by OAuth, paste a long-lived token, or set up a <a href="/sources">managed connection</a>${canManaged ? "" : " (PRO)"} to connect all your accounts at once.</p>
            <div x-data="{ tg: false }">
              <div class="action-bar" style="margin:0">
                ${hasFb && !canMultiChannel ? proConnect("Facebook") : html`<a class="btn btn-secondary" href="/api/oauth/facebook">+ Facebook</a>`}
                ${hasIg && !canMultiChannel ? proConnect("Instagram") : html`<a class="btn btn-secondary" href="/api/oauth/instagram">+ Instagram</a>`}
                ${canNonMeta ? html`<a class="btn btn-secondary" href="/api/oauth/youtube">+ YouTube</a>` : proConnect("YouTube")}
                ${canNonMeta
                  ? html`<button class="btn btn-secondary" type="button" @click="tg = !tg">+ Telegram</button>`
                  : proConnect("Telegram")}
                ${canNonMeta ? html`<a class="btn btn-secondary" href="/api/oauth/gmail">+ Gmail</a>` : proConnect("Gmail")}
                <a class="btn btn-secondary" href="/api/oauth/instagram-login">+ Instagram (messaging)</a>
              </div>
              <p class="set-lead" style="margin:.5rem 0 0">Instagram (messaging) connects an Instagram account directly — DMs, comments and publishing in one, at Standard Access (no App Review), no Facebook page required. Add Facebook only for page-managed publishing across many accounts; the two combine in any order.</p>
              ${instagramLoginInstructions()}
              ${(hasFb || hasIg) && !canMultiChannel
                ? html`<p class="set-lead" style="margin:.75rem 0 0">Free includes one Facebook + one Instagram channel. More channels — and Telegram — are PRO.</p>`
                : ""}
              <div x-show="tg" x-cloak style="margin-top:.75rem">
                <p class="set-lead" style="margin:0 0 .5rem">In Telegram, message <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> → <code>/newbot</code> → copy the bot token. We register the webhook for you.</p>
                <form class="connect-form" hx-post="/channels/telegram/connect" hx-ext="json-enc" hx-target="#channels-toast" hx-swap="innerHTML">
                  <input class="input" name="token" placeholder="123456789:AA..." required />
                  <button class="btn btn-primary btn-sm" type="submit">Connect Telegram</button>
                </form>
              </div>
            </div>
            <div class="cred-subhead">Connect a token manually</div>
            <form class="connect-form" hx-post="/channels/connect-token" hx-ext="json-enc" hx-target="#channels-toast" hx-swap="innerHTML">
              <select name="platform" aria-label="Platform"><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select>
              <input class="input" name="token" placeholder="paste long-lived / System User token" required />
              <button class="btn btn-primary btn-sm" type="submit">Connect</button>
            </form>
            <div id="channels-toast"></div>
          </div>
        </section>`,
    }),
  );
}

// ── channel detail ───────────────────────────────────────────────────────────────────────────

function metaRow(label: string, value: Html | string): Html {
  return html`<div class="meta-row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function tokenPanel(ch: PublicChannel): Html {
  const expires = ch.token_expires_at;
  let expiryCell: Html;
  if (!expires) {
    expiryCell = html`<span class="meta-mono">— <small>no expiry</small></span>`;
  } else {
    const days = (expires.getTime() - Date.now()) / 86400000;
    const expired = days <= 0;
    const near = !expired && days <= TOKEN_WARN_DAYS;
    const tag = expired ? pill("expired", "bad") : near ? pill(relTime(expires), "warn") : pill(relTime(expires), "ok");
    expiryCell = html`<span class="meta-mono">${fmtDate(expires)}</span> ${tag}`;
  }
  const reasonRow = ch.needs_reauth_reason ? metaRow("Reauth reason", html`<span class="reason">${ch.needs_reauth_reason}</span>`) : "";
  const lastErrorRow = ch.last_error ? metaRow("Last error", lastErrorNote(ch)) : "";
  return html`<section class="panel">
    <div class="panel-head"><h3>Token</h3></div>
    ${messagingHint(ch)}
    <dl class="meta-list">
      ${metaRow("Access token", html`<code class="token-mask">••••••••••••••••</code>`)}
      ${metaRow("Expires", expiryCell)}
      ${reasonRow}
      ${lastErrorRow}
    </dl>
  </section>`;
}

function ratePanel(rate: { tokens: number; updatedAt: Date } | undefined): Html {
  if (!rate) {
    return html`<section class="panel">
      <div class="panel-head"><h3>Rate limit</h3></div>
      <dl class="meta-list">${metaRow("Bucket", html`<small>No activity yet — bucket unallocated.</small>`)}</dl>
    </section>`;
  }
  const low = rate.tokens <= 5;
  return html`<section class="panel">
    <div class="panel-head"><h3>Rate limit</h3></div>
    <dl class="meta-list">
      ${metaRow("Tokens left", html`<span class="meta-mono">${rate.tokens}</span> ${low ? pill("low", "warn") : ""}`)}
      ${metaRow("Refilled", html`<span class="meta-mono">${relTime(rate.updatedAt)}</span>`)}
    </dl>
  </section>`;
}

function eventTone(type: string): Tone {
  if (type.endsWith(".failed") || type.endsWith(".needs_reauth")) return "bad";
  if (type.endsWith(".data_access_expiring") || type.endsWith(".held")) return "warn";
  if (type.endsWith(".published") || type.endsWith(".sent") || type.endsWith(".reconnected")) return "ok";
  return "info";
}

const HX_HEAD = `hx-target="#ch-detail-head" hx-swap="outerHTML"`;
function actionForm(action: string, label: string, variant: "secondary" | "danger", confirmMsg?: string): Html {
  const hxConfirm = confirmMsg ? raw(` hx-confirm="${confirmMsg}" data-confirm-label="${label}"`) : raw("");
  return html`<form method="post" action="${action}" hx-post="${action}" ${raw(HX_HEAD)}${hxConfirm}>${btn({ label, variant })}</form>`;
}

function reconnectControl(ch: PublicChannel): Html {
  const href = reconnectHref(ch);
  if (ch.connection_mode === "derived") return btn({ label: "Reconnect master", href, variant: "primary", icon: "reconnect" });
  if (ch.connection_mode === "oauth") return btn({ label: "Reconnect", href, variant: "primary", icon: "reconnect" });
  return html``;
}

/** A3: clarify what "Reconnect" does for an `instagram_login` channel. `reconnectHref` routes these to
 *  the IG-Login flow (re-mints the 60-day messaging token — the realistic reauth; FB page tokens are
 *  effectively permanent). But that value is also true for a COMBINED Facebook-page + IG-Login channel,
 *  where one button would misleadingly imply Facebook publishing is also fixed. So when Facebook
 *  publishing is also affected on such a channel, point the operator at the Facebook reauth too.
 *  Empty for non-`instagram_login` channels (incl. `facebook_only` and plain Facebook). */
export function reconnectNote(ch: PublicChannel): Html {
  if (ch.messaging_connection !== "instagram_login") return html``;
  return html`<div class="notice notice-info" style="flex-basis:100%">
    Reconnecting re-mints Instagram messaging. If this is a combined Facebook + Instagram channel and
    Facebook publishing is also affected, <a href="/api/oauth/instagram">reconnect Facebook</a> too.
  </div>`;
}

function actionBar(ch: PublicChannel): Html {
  const back = `/channels/${ch.id}`;
  const remove = actionForm(`${back}/remove`, "Remove", "danger", "Remove this channel? It stops publishing and leaves the list.");
  const hideToggle = ch.hidden_at ? actionForm(`${back}/unhide`, "Unhide", "secondary") : actionForm(`${back}/hide`, "Hide", "secondary");
  if (ch.status === "disabled") {
    return html`<div class="action-bar">${actionForm(`${back}/enable`, "Enable", "secondary")}${hideToggle}${remove}</div>`;
  }
  const pauseOrResume = ch.status === "paused"
    ? actionForm(`${back}/resume`, "Resume", "secondary")
    : actionForm(`${back}/pause`, "Pause", "secondary");
  return html`<div class="action-bar">
    ${reconnectControl(ch)}
    ${reconnectNote(ch)}
    ${actionForm(`${back}/health-check`, "Health-check", "secondary")}
    ${pauseOrResume}
    ${hideToggle}
    ${actionForm(`${back}/disable`, "Disable", "danger", "Disable this channel? It will stop publishing until reconnected.")}
    ${remove}
  </div>`;
}

/** Whether the channel's platform can post a top-level comment on a published post (FIRSTCOMMENT1).
 *  Duck-typed off the provider so a new publishing platform lights up the panel automatically. */
function platformSupportsFirstComment(platform: string): boolean {
  try {
    return getProvider(platform as Platform).supportsFeature("comment_on_post");
  } catch {
    return false;
  }
}

/** FIRSTCOMMENT1: per-channel default first-comment editor (shown only for platforms that can
 *  comment on their own posts). The per-post override travels on the publish request, not here. */
function firstCommentPanel(ch: PublicChannel, licensed: boolean, upgradeUrl: string, oob = false): Html {
  if (!platformSupportsFirstComment(ch.platform)) return html``;
  // Same out-of-band pattern as the Auto-Story panel: the control lives here, not in #ch-detail-head,
  // so the save action re-renders this panel in place (reflecting the saved value), no page reload.
  const body = licensed
    ? html`<p class="set-lead">
        Auto-posted as the first comment under every post published to this channel
        (e.g. “link in the comments 👇”). Leave empty to turn it off.
      </p>
      <form class="panel-form" method="post" action="/channels/${ch.id}/first-comment"
        hx-post="/channels/${ch.id}/first-comment" hx-target="#ch-detail-head" hx-swap="outerHTML">
        <textarea name="firstComment" rows="3" maxlength="2000"
          placeholder="e.g. Grab the free guide → https://…"
          aria-label="Default first comment"
          style="width:100%;resize:vertical;font:inherit">${ch.default_first_comment ?? ""}</textarea>
        ${btn({ label: "Save first comment", variant: "secondary", size: "sm" })}
      </form>`
    : html`<p class="set-lead">
        Auto-post a first comment (e.g. “link in the comments 👇”) under every post published to this channel.
      </p>
      <a class="btn btn-secondary btn-sm" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">${icon("lock", "ico", 13)} First comment (PRO)</a>`;
  return html`<section class="panel" id="first-comment-panel"${oob ? raw(' hx-swap-oob="true"') : raw("")}>
    <div class="panel-head"><h3>First comment</h3></div>
    <div class="set-body">${body}</div>
  </section>`;
}

/** Whether the channel's platform can publish a Story (STORY1). Duck-typed off the PUBLISH provider
 *  so a new Story-capable platform lights up the panel automatically. */
function platformSupportsStory(platform: string): boolean {
  try {
    return getProviderForPlatform(platform).publishStory != null;
  } catch {
    return false;
  }
}

/** STORY1: per-channel auto-Story toggle (shown only for platforms that can publish a Story). When on,
 *  every published post also auto-publishes a generated Story card. The per-post override travels on
 *  the publish request, not here. */
function storyPanel(ch: PublicChannel, licensed: boolean, upgradeUrl: string, oob = false): Html {
  if (!platformSupportsStory(ch.platform)) return html``;
  const on = ch.default_auto_story;
  // The toggle lives in THIS panel (not in #ch-detail-head), so the action's response re-renders it
  // out-of-band (hx-swap-oob) — the button label + status flip in place, no page reload.
  const body = licensed
    ? html`<p class="set-lead">
        Auto-publish a generated Story card (cover + caption) about every post published to this
        channel. ${on ? "Currently on." : "Currently off."}
      </p>
      <form class="panel-form" method="post" action="/channels/${ch.id}/auto-story"
        hx-post="/channels/${ch.id}/auto-story" hx-target="#ch-detail-head" hx-swap="outerHTML">
        <input type="hidden" name="enabled" value="${on ? "0" : "1"}" />
        ${btn({ label: on ? "Turn off auto-Story" : "Turn on auto-Story", variant: on ? "danger" : "secondary", size: "sm" })}
      </form>`
    : html`<p class="set-lead">
        Auto-publish a generated Story card (cover + caption) about every post published to this channel.
      </p>
      <a class="btn btn-secondary btn-sm" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">${icon("lock", "ico", 13)} Auto-Story (PRO)</a>`;
  return html`<section class="panel" id="story-panel"${oob ? raw(' hx-swap-oob="true"') : raw("")}>
    <div class="panel-head"><h3>Auto-Story</h3></div>
    <div class="set-body">${body}</div>
  </section>`;
}

/** AIDRAFT1 (Task 8): per-channel AI-draft settings (PRO). Enable drafting on this channel, choose
 *  the surface (dm / public comments / both), an optional prompt override (blank inherits the
 *  workspace default), and two ADVANCED auto-send toggles that send a high-confidence draft WITHOUT
 *  manual approval. Mirrors the first-comment/auto-story out-of-band pattern: the form posts to
 *  /channels/:id/ai-draft, which re-renders #ch-detail-head and refreshes THIS panel out-of-band.
 *  Every dynamic value is escaped by `html`` (the saved prompt is operator text but escaped anyway). */
export function aiDraftPanel(ch: PublicChannel, licensed: boolean, upgradeUrl: string, oob = false, aiConfigured = true): Html {
  const targetOpt = (value: PublicChannel["ai_draft_target"], label: string) =>
    html`<option value="${value}"${ch.ai_draft_target === value ? raw(" selected") : raw("")}>${label}</option>`;
  const body = licensed
    ? html`${aiConfigured ? html`` : aiUnconfiguredBanner("AI drafts")}
      <p class="set-lead">
        When enabled, PostStack drafts an AI reply for new activity on this channel and parks it here
        for your approval. Leave the prompt blank to inherit the workspace default.
      </p>
      <form class="panel-form" method="post" action="/channels/${ch.id}/ai-draft"
        hx-post="/channels/${ch.id}/ai-draft" hx-target="#ch-detail-head" hx-swap="outerHTML">
        <label class="compose-toggle">
          <input type="checkbox" name="enabled" value="1" ${ch.ai_draft_enabled ? raw("checked") : raw("")} />
          <span>Draft AI replies for this channel</span>
        </label>
        <label class="fld" style="margin-top:.6rem"><span>Apply to</span>
          <select name="target" aria-label="AI-draft target">
            ${targetOpt("dm", "Direct messages")}
            ${targetOpt("public", "Public comments")}
            ${targetOpt("both", "Both")}
          </select>
        </label>
        <label class="fld" style="margin-top:.6rem"><span>DM prompt override <small>— blank inherits the workspace default, then the built-in default below</small></span>
          <textarea name="promptDm" rows="3" maxlength="4000"
            placeholder="Inherit workspace default"
            aria-label="AI-draft DM prompt override"
            style="width:100%;resize:vertical;font:inherit">${ch.ai_draft_prompt_dm ?? ""}</textarea>
        </label>
        <label class="fld" style="margin-top:.6rem"><span>Public comment prompt override <small>— blank inherits the workspace default, then the built-in default below</small></span>
          <textarea name="promptPublic" rows="3" maxlength="4000"
            placeholder="Inherit workspace default"
            aria-label="AI-draft public comment prompt override"
            style="width:100%;resize:vertical;font:inherit">${ch.ai_draft_prompt_public ?? ""}</textarea>
        </label>
        <p class="muted" style="font-size:.72rem;margin:.2rem 0 0">Built-in default (used when both are blank): <span class="mono">${DEFAULT_DRAFT_PROMPT}</span></p>
        <label class="compose-toggle" style="margin-top:.6rem">
          <input type="checkbox" name="autosendDm" value="1" ${ch.ai_draft_autosend_dm ? raw("checked") : raw("")} />
          <span>Auto-send DM drafts <small>(advanced — sends without review (no approval))</small></span>
        </label>
        <label class="compose-toggle">
          <input type="checkbox" name="autosendPublic" value="1" ${ch.ai_draft_autosend_public ? raw("checked") : raw("")} />
          <span>Auto-send public drafts <small>(advanced — sends without review (no approval))</small></span>
        </label>
        ${btn({ label: "Save AI-draft settings", variant: "secondary", size: "sm" })}
      </form>`
    : html`<p class="set-lead">
        Draft AI replies for new messages and comments on this channel, parked here for your approval.
      </p>
      <a class="btn btn-secondary btn-sm" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">${icon("lock", "ico", 13)} AI-drafted replies (PRO)</a>`;
  return html`<section class="panel" id="ai-draft-panel"${oob ? raw(' hx-swap-oob="true"') : raw("")}>
    <div class="panel-head"><h3>AI-drafted replies</h3></div>
    <div class="set-body">${body}</div>
  </section>`;
}

/** Gmail-channel ingest filter panel — shown only for Gmail channels.
 *  Saves gmail_query via POST /api/v1/channels/:id/gmail-filter. */
function gmailFilterPanel(ch: PublicChannel, oob = false): Html {
  if (ch.platform !== "gmail") return html``;
  return html`<section class="panel" id="gmail-filter-panel"${oob ? raw(' hx-swap-oob="true"') : raw("")}>
    <div class="panel-head"><h3>Ingest filter</h3></div>
    <div class="set-body">
      <p class="set-lead">
        Gmail search query that controls which messages PostStack pulls in.
        Leave empty to use the default (<code>in:inbox</code>).
      </p>
      <form class="panel-form" method="post" action="/channels/${ch.id}/gmail-filter"
        hx-post="/channels/${ch.id}/gmail-filter" hx-target="#ch-detail-head" hx-swap="outerHTML">
        <input name="query" type="text" maxlength="1000"
          placeholder="e.g. label:Support from:vip@x.com"
          value="${ch.gmail_query ?? ""}"
          aria-label="Gmail ingest query"
          style="width:100%;font:inherit" />
        ${btn({ label: "Save filter", variant: "secondary", size: "sm" })}
      </form>
    </div>
  </section>`;
}

function manualReconnectForm(ch: PublicChannel): Html {
  if (ch.connection_mode !== "manual_token") return html``;
  return html`<section class="panel">
    <div class="panel-head"><h3>Reconnect</h3></div>
    <div class="set-body">
      <p class="set-lead">Paste a fresh long-lived / System User token to reconnect this channel.</p>
      <form class="connect-form" method="post" action="/channels/${ch.id}/reconnect">
        <input class="input" name="token" placeholder="paste long-lived / System User token" required />
        ${btn({ label: "Reconnect", variant: "primary", size: "sm", icon: "reconnect" })}
      </form>
    </div>
  </section>`;
}

function detailHead(ch: PublicChannel): Html {
  const name = ch.display_name ?? ch.provider_account_id;
  const statusTone = STATUS_META[ch.status].tone;
  const av = channelAvatar(ch);
  const avatar = av && av.startsWith("https://")
    ? html`<img class="detail-avatar" src="${av}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
    : "";
  const handle = channelHandle(ch);
  const handleStr = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : null;
  const handleBit = handleStr ? html`<code class="detail-handle">${handleStr}</code>` : "";
  return html`<section class="detail-head tone-edge-${statusTone}" id="ch-detail-head">
    <div class="detail-id">
      <span class="detail-glyph">${avatar}${platformCell(ch.platform, ch.metadata)}</span>
      <div class="detail-name">
        <h2>${name}</h2>
        <div class="detail-sub">
          ${statusBadge(ch.status)}
          <span class="mode-tag">${ch.connection_mode}</span>
          ${capabilityBadges(ch)}
          ${messagingConnectionBadge(ch)}
          ${handleBit}
          ${ch.provider_account_id === ch.display_name ? "" : html`<code class="detail-acct">${ch.provider_account_id}</code>`}
        </div>
        <details class="ch-rename">
          <summary>Rename</summary>
          <form class="ch-rename-form" method="post" action="/channels/${ch.id}/rename"
            hx-post="/channels/${ch.id}/rename" hx-target="#ch-detail-head" hx-swap="outerHTML">
            <input name="displayName" value="${ch.display_name ?? ""}" placeholder="Display name" aria-label="Channel display name" required maxlength="200" />
            ${btn({ label: "Save", variant: "secondary", size: "sm" })}
          </form>
        </details>
      </div>
    </div>
    ${actionBar(ch)}
  </section>`;
}

async function channelDetailPage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
  const ch = await getChannel(a.workspaceId, id);
  if (!ch) return c.text("not found", 404);

  const [rate, posts, events] = await Promise.all([
    getChannelRateState(a.workspaceId, id),
    listDeliveries({ workspaceId: a.workspaceId, limit: 10, channelId: id }),
    db.query.events.findMany({
      where: and(eq(eventsTbl.workspace_id, a.workspaceId), eq(eventsTbl.subject_id, id)),
      orderBy: [desc(eventsTbl.created_at)],
      limit: 10,
    }),
  ]);

  const name = ch.display_name ?? ch.provider_account_id;
  const lic = await getInstanceLicense();
  const aiConfigured = await isAiConfigured();
  // Per-channel activity stats — PRO (reuses contacts_crm: knowing your audience/volume).
  const canStats = lic.features.has("contacts_crm");
  const stats = canStats
    ? await (async () => {
        const [conv, msg, cmt, posts] = await Promise.all([
          db.select({ n: count() }).from(conversationsTbl).where(eq(conversationsTbl.channel_id, id)),
          db.select({ n: count() }).from(messagesTbl).innerJoin(conversationsTbl, eq(conversationsTbl.id, messagesTbl.conversation_id)).where(eq(conversationsTbl.channel_id, id)),
          db.select({ n: count() }).from(commentLogsTbl).where(eq(commentLogsTbl.channel_id, id)),
          db.select({ n: count() }).from(deliveriesTbl).where(and(eq(deliveriesTbl.channel_id, id), eq(deliveriesTbl.status, "sent"))),
        ]);
        return { conversations: conv[0]?.n ?? 0, messages: msg[0]?.n ?? 0, comments: cmt[0]?.n ?? 0, posts: posts[0]?.n ?? 0 };
      })()
    : null;

  const postRows = posts.items.length
    ? posts.items.map((p) => html`<a class="rec-row" href="/queue">
        <span class="rec-time">${relTime(p.created_at)}</span>
        <span class="rec-fmt">${p.format}</span>
        ${statusBadge(p.status)}
      </a>`)
    : html`<div class="rec-empty"><small>No posts for this channel yet.</small></div>`;

  const eventRows = events.length
    ? events.map((e) => html`<div class="feed-row">
        ${dot(eventTone(e.type))}
        <span class="feed-main"><span class="feed-type">${e.type}</span></span>
        <span class="feed-time">${relTime(e.created_at)}</span>
      </div>`)
    : html`<div class="rec-empty"><small>No events recorded for this channel.</small></div>`;

  return c.html(
    renderPage({
      title: name,
      nav: "channels",
      features: lic.features,
      products: lic.products,
      breadcrumb: `Channels / ${name}`,
      primaryAction: btn({ label: "All channels", href: "/channels", variant: "ghost" }),
      body: html`${detailHead(ch)}
        <div class="action-bar" style="margin:.5rem 0">
          ${btn({ label: "View inbox", href: `/inbox?channel=${ch.id}`, variant: "secondary" })}
          ${btn({ label: "Published posts", href: `/queue?channel=${ch.id}`, variant: "secondary" })}
        </div>
        ${stats
          ? html`<section class="panel"><div class="panel-head"><h3>Stats</h3></div>
              <div class="set-body" style="display:flex;flex-wrap:wrap;gap:1.5rem">
                <div><div class="kpi-n">${stats.posts}</div><div class="kpi-l">Posts published</div></div>
                <div><div class="kpi-n">${stats.conversations}</div><div class="kpi-l">Conversations</div></div>
                <div><div class="kpi-n">${stats.messages}</div><div class="kpi-l">Messages</div></div>
                <div><div class="kpi-n">${stats.comments}</div><div class="kpi-l">Comments</div></div>
              </div></section>`
          : html`<section class="panel"><div class="set-body"><p class="set-lead" style="margin:0">${icon("lock", "ico", 13)} Channel stats (posts & messages) are a PRO feature.</p></div></section>`}
        ${firstCommentPanel(ch, lic.features.has("first_comment"), lic.upgradeUrl)}
        ${storyPanel(ch, lic.features.has("auto_story"), lic.upgradeUrl)}
        ${aiDraftPanel(ch, lic.features.has("ai_draft"), lic.upgradeUrl, false, aiConfigured)}
        ${gmailFilterPanel(ch)}
        <div class="detail-grid">${tokenPanel(ch)}${ratePanel(rate)}</div>
        <div class="detail-grid">
          <section class="panel">
            <div class="panel-head"><h3>Recent posts</h3><a class="panel-more" href="/queue?channel=${ch.id}">Queue →</a></div>
            <div class="panel-body">${postRows}</div>
          </section>
          <section class="panel">
            <div class="panel-head"><h3>Event history</h3><a class="panel-more" href="/events">Events →</a></div>
            <div class="panel-body">${eventRows}</div>
          </section>
        </div>
        ${manualReconnectForm(ch)}`,
    }),
  );
}

export function registerChannels(r: Hono, guard: MiddlewareHandler): void {
  r.get("/channels", guard, channelsPage);
  r.get("/channels/:id", guard, channelDetailPage);

  // Operational actions: perform via the service, then respond (303 no-JS / detail-head swap + toast for HTMX).
  // `oob` lets a route whose control lives OUTSIDE #ch-detail-head (e.g. the Auto-Story panel) return
  // an extra out-of-band fragment so that panel refreshes in place too — no full page reload.
  function action(
    run: (ws: string, id: string, c: Context) => Promise<unknown>,
    toast: (ch: PublicChannel) => string,
    oob?: (ch: PublicChannel) => Html,
    feature?: Feature,
  ) {
    return async (c: Context) => {
      const a = await auth(c);
      if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
      const id = c.req.param("id");
      if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
      // PRO gate (defense-in-depth): the UI hides the control when unlicensed, but block the endpoint
      // too so it can't be toggled out-of-band on a free instance.
      if (feature && !(await hasFeature(feature))) return c.text(proMessage(feature), 402);
      try {
        await run(a.workspaceId, id, c);
      } catch (err) {
        if (err instanceof ApiError) return c.text(err.message, err.status as 400);
        throw err;
      }
      if (!isHtmx(c)) return c.redirect(`/channels/${id}`, 303);
      const ch = await getChannel(a.workspaceId, id);
      if (!ch) return c.text("not found", 404);
      const tone: ToastTone = ch.status === "active" ? "ok" : ch.status === "needs_reauth" ? "warn" : "info";
      toastHeader(c, tone, toast(ch));
      return c.html(html`${detailHead(ch)}${oob ? oob(ch) : ""}`);
    };
  }

  r.post("/channels/:id/health-check", guard, action((ws, id) => runHealthCheck(ws, id), (ch) =>
    ch.status === "active" ? "Health check passed" : "Health check: channel needs reauth"));
  r.post("/channels/:id/pause", guard, action((ws, id) => setChannelStatus(ws, id, "paused"), () => "Channel paused"));
  r.post("/channels/:id/resume", guard, action((ws, id) => setChannelStatus(ws, id, "active"), () => "Channel resumed"));
  r.post("/channels/:id/disable", guard, action((ws, id) => setChannelStatus(ws, id, "disabled"), () => "Channel disabled"));
  r.post("/channels/:id/enable", guard, action((ws, id) => setChannelStatus(ws, id, "active"), () => "Channel enabled"));
  r.post("/channels/:id/rename", guard, action(async (ws, id, c) => {
    const form = await c.req.parseBody();
    await setChannelDisplayName(ws, id, String(form.displayName ?? ""));
  }, () => "Name updated"));
  r.post("/channels/:id/first-comment", guard, action(async (ws, id, c) => {
    const form = await c.req.parseBody();
    await setChannelDefaultFirstComment(ws, id, String(form.firstComment ?? ""));
  }, (ch) => ch.default_first_comment ? "First comment saved" : "First comment turned off",
    (ch) => firstCommentPanel(ch, true, "", true), "first_comment"));
  r.post("/channels/:id/auto-story", guard, action(async (ws, id, c) => {
    const form = await c.req.parseBody();
    await setChannelDefaultAutoStory(ws, id, String(form.enabled ?? "") === "1");
  }, (ch) => ch.default_auto_story ? "Auto-Story turned on" : "Auto-Story turned off",
    (ch) => storyPanel(ch, true, "", true), "auto_story"));
  r.post("/channels/:id/gmail-filter", guard, action(async (ws, id, c) => {
    const form = await c.req.parseBody();
    const q = String(form.query ?? "").slice(0, 1000);
    await setChannelGmailQuery(ws, id, q);
  }, (ch) => ch.gmail_query ? "Filter saved" : "Filter cleared",
    (ch) => gmailFilterPanel(ch, true)));
  // AIDRAFT1 (Task 8): persist per-channel AI-draft settings. Dedicated handler (not the generic
  // `action()`) because it needs feature-specific status codes: free → 403 (no write), invalid
  // target → 422, foreign channel → 404. PRO gate enforced server-side (defense-in-depth: the UI
  // hides the form on a free instance, but a forged POST is refused here too).
  r.post("/channels/:id/ai-draft", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    if (!(await hasFeature("ai_draft"))) {
      if (isHtmx(c)) toastHeader(c, "warn", "AI-drafted replies are a PRO feature.");
      return c.text(proMessage("ai_draft"), 403);
    }
    // Ownership first — a foreign / missing id is a 404 before we read the body.
    if (!(await getChannel(a.workspaceId, id))) return c.text("not found", 404);
    const form = await c.req.parseBody();
    const target = String(form.target ?? "");
    if (!isAiDraftTarget(target)) {
      if (isHtmx(c)) toastHeader(c, "bad", "Pick a valid reply target.");
      return c.text("invalid target", 422);
    }
    await setChannelAiDraftSettings(a.workspaceId, id, {
      enabled: String(form.enabled ?? "") === "1",
      target,
      promptDm: String(form.promptDm ?? ""),
      promptPublic: String(form.promptPublic ?? ""),
      autosendDm: String(form.autosendDm ?? "") === "1",
      autosendPublic: String(form.autosendPublic ?? "") === "1",
    });
    const ch = await getChannel(a.workspaceId, id);
    if (!ch) return c.text("not found", 404);
    if (!isHtmx(c)) return c.redirect(`/channels/${id}`, 303);
    toastHeader(c, "ok", "AI-draft settings saved");
    return c.html(html`${detailHead(ch)}${aiDraftPanel(ch, true, "", true, await isAiConfigured())}`);
  });

  r.post("/channels/:id/hide", guard, action((ws, id) => setChannelHidden(ws, id, true), () => "Channel hidden"));
  r.post("/channels/:id/unhide", guard, action((ws, id) => setChannelHidden(ws, id, false), () => "Channel unhidden"));
  r.post("/channels/:id/reconnect", guard, action(async (ws, id, c) => {
    const token = String((await c.req.parseBody()).token ?? "").trim();
    if (!token) throw new ApiError("invalid_request", "Token is required", 400);
    await reconnectManualToken(ws, id, token);
  }, () => "Channel reconnected"));

  // Remove = soft delete → list leaves; HTMX redirects to the list with a toast.
  r.post("/channels/:id/remove", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    try {
      await deleteChannel(a.workspaceId, id);
    } catch (err) {
      if (err instanceof ApiError) return c.text(err.message, err.status as 400);
      throw err;
    }
    if (!isHtmx(c)) return c.redirect("/channels", 303);
    toastHeader(c, "ok", "Channel removed");
    c.header("HX-Redirect", "/channels");
    return c.body(null, 200);
  });

  // Assign / clear a channel's brand (toast only; reload regroups).
  r.put("/channels/:id/brand", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
    const brandKey = String((await c.req.parseBody()).brandKey ?? "").trim();
    try {
      await assignChannelBrand(a.workspaceId, id, brandKey || null);
    } catch (err) {
      if (err instanceof ApiError) return c.text(err.message, err.status as 400);
      throw err;
    }
    if (isHtmx(c)) toastHeader(c, "ok", brandKey ? "Brand assigned" : "Brand cleared");
    return c.body(null, 200);
  });
}
