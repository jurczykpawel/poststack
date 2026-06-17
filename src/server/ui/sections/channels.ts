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
import type { Platform } from "@/db/schema";
import { listDeliveries } from "@/lib/deliveries/service";
import { listBrands, assignChannelBrand, type BrandRow } from "@/lib/brands/service";
import { ApiError } from "@/lib/api/response";
import { getInstanceLicense, hasFeature } from "@/lib/license/gate";
import { proMessage, type Feature } from "@/lib/license/features";
import { renderPage } from "../layout";
import { statusBadge, pill, dot, type Tone } from "../components/status";
import { platformCell, platformLabel } from "../components/platform";
import { btn } from "../components/button";
import { accountCell } from "../components/account";
import { oauthStartHref } from "../components/reconnect";
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
function capabilityBadges(ch: PublicChannel): Html {
  const ctx = { platform: ch.platform, connection_mode: ch.connection_mode, metadata: ch.metadata };
  const on = CAP_LABEL.filter((c) => can(ctx, c.cap));
  if (on.length === 0) return html`<small>—</small>`;
  return html`<span class="pill-row">${on.map((c) => pill(c.label, "info"))}</span>`;
}

/** The per-row reconnect action — only shown on a channel that actually needs it. */
function reauthAction(ch: PublicChannel): Html {
  if (ch.status !== "needs_reauth") return html`<small>—</small>`;
  if (ch.connection_mode === "derived") return html`<a href="/sources">Reconnect master →</a>`;
  const start = oauthStartHref(ch.platform);
  if (ch.connection_mode === "oauth" && start) {
    return html`<a class="act" role="button" href="${start}">Reconnect</a>`;
  }
  // manual_token → reconnect on the detail page (paste a fresh token).
  return html`<a class="act outline" role="button" href="/channels/${ch.id}">Reconnect →</a>`;
}

function sortLink(params: URLSearchParams, sort: ChannelSort): string {
  const p = new URLSearchParams(params);
  p.set("sort", sort);
  const qs = p.toString();
  return qs ? `/channels?${qs}` : "/channels";
}

function sortHead(label: string, sort: ChannelSort, active: ChannelSort, params: URLSearchParams): Html {
  const isActive = active === sort;
  const ariaSort = isActive ? raw(' aria-sort="ascending"') : raw("");
  const arrow = isActive ? raw(' <span class="th-arrow" aria-hidden="true">↑</span>') : "";
  return html`<th scope="col"${ariaSort}><a class="th-sort" href="${sortLink(params, sort)}">${label}${arrow}</a></th>`;
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
  const sortField = active.sort !== "recent" ? html`<input type="hidden" name="sort" value="${active.sort}" />` : "";
  const hiddenField = active.showHidden ? html`<input type="hidden" name="showHidden" value="1" />` : "";
  const hasFilters = !!(active.platform || active.status || active.q);
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
    ${sortField}${hiddenField}
    <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
    ${hasFilters ? html`<a class="filter-clear" href="${active.showHidden ? "/channels?showHidden=1" : "/channels"}">Clear</a>` : ""}
  </form>`;
}

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

function channelRow(ch: PublicChannel, brands: BrandRow[]): Html {
  return html`<tr>
    <td data-label="Platform"><a class="row-link" href="/channels/${ch.id}">${platformCell(ch.platform, ch.metadata)}</a></td>
    <td data-label="Account"><a class="row-link row-name" href="/channels/${ch.id}">${accountCell(ch.display_name, ch.provider_account_id, channelAvatar(ch), channelHandle(ch))}</a></td>
    <td data-label="Status">${statusBadge(ch.status)}</td>
    <td data-label="Can">${capabilityBadges(ch)}</td>
    <td data-label="Brand">${brandSelect(ch, brands)}</td>
    <td data-label="Action">${reauthAction(ch)}</td>
  </tr>`;
}

/** Group channel rows by owning brand (brands A→Z, then Unassigned). */
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
  return html`${orderedKeys.map((k) => {
    const list = groups.get(k)!;
    const label = k === "" ? "Unassigned" : (nameByKey.get(k) ?? k);
    return html`<tr class="row-group-head"><td colspan="6">${label} <span class="muted">(${list.length})</span></td></tr>
      ${list.map((ch) => channelRow(ch, brands))}`;
  })}`;
}

const CHANNEL_ERRORS: Record<string, string> = {
  access_denied: "Access denied — you cancelled the connection.",
  no_pages: "No Facebook Pages found. Make sure you manage at least one Page.",
  no_ig_accounts: "No Instagram Business accounts found linked to your Pages.",
  oauth_failed: "Connection failed. Please try again.",
  pro_required: "That channel needs a PRO license.",
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

  const persist = new URLSearchParams();
  if (platformParam) persist.set("platform", platformParam);
  if (status) persist.set("status", status);
  if (q) persist.set("q", q);
  if (sourceId) persist.set("sourceId", sourceId);
  if (showHidden) persist.set("showHidden", "1");

  const rows = channelGroups(items, brands);
  const platformsForFilter = Object.keys(countsByPlatform).sort();
  const empty = items.length === 0;
  const canManaged = lic.features.has("managed_connection");
  const canMultiChannel = lic.features.has("multi_channel");
  const canNonMeta = lic.features.has("non_meta_channels");
  const upgradeUrl = lic.upgradeUrl;
  const hasFb = items.some((ch) => ch.platform === "facebook" && ch.status !== "disabled");
  const hasIg = items.some((ch) => ch.platform === "instagram" && ch.status !== "disabled");
  // A locked connect affordance: links to the upgrade page instead of connecting.
  const proConnect = (label: string) =>
    html`<a class="btn btn-secondary" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">🔒 ${label} (PRO)</a>`;

  return c.html(
    renderPage({
      title: "Channels",
      nav: "channels",
      features: lic.features,
      products: lic.products,
      breadcrumb: sourceId ? `${items.length} shown · filtered by source` : `${items.length} shown`,
      body: html`${errorKey ? html`<div class="auth-error">${CHANNEL_ERRORS[errorKey] ?? "Something went wrong."}</div>` : ""}
        ${connected && connectedCount ? html`<div class="empty-body" style="color:var(--ok-text)">${connectedCount} ${platformLabel(connected)} account(s) connected.</div>` : ""}
        ${countsHeader(countsByStatus, countsByPlatform, { status, platform: platformParam, showHidden }, hiddenCount)}
        ${filterBar(platformsForFilter, { platform: platformParam, status, q, sort, showHidden })}
        <div class="table-wrap">
          <table class="data-table" aria-label="Channels">
            <thead>
              <tr>
                ${sortHead("Platform", "platform", sort, persist)}
                ${sortHead("Account", "name", sort, persist)}
                ${sortHead("Status", "status", sort, persist)}
                <th scope="col">Can</th>
                <th scope="col">Brand</th>
                <th scope="col" class="th-act">Action</th>
              </tr>
            </thead>
            <tbody>
              ${empty ? html`<tr><td colspan="6" class="table-empty">No channels match these filters.</td></tr>` : rows}
            </tbody>
          </table>
        </div>
        <h3>Connect a channel</h3>
        <p><small>Connect a Facebook Page or Instagram Business account by OAuth, paste a long-lived token, or set up a <a href="/sources">managed connection</a>${canManaged ? "" : " (PRO)"} to connect all your accounts at once.</small></p>
        <div x-data="{ tg: false }">
          <div class="action-bar" style="margin:0">
            ${hasFb && !canMultiChannel ? proConnect("Facebook") : html`<a class="btn btn-secondary" href="/api/oauth/facebook">+ Facebook</a>`}
            ${hasIg && !canMultiChannel ? proConnect("Instagram") : html`<a class="btn btn-secondary" href="/api/oauth/instagram">+ Instagram</a>`}
            ${canNonMeta ? html`<a class="btn btn-secondary" href="/api/oauth/youtube">+ YouTube</a>` : proConnect("YouTube")}
            ${canNonMeta
              ? html`<button class="btn btn-secondary" type="button" @click="tg = !tg">+ Telegram</button>`
              : proConnect("Telegram")}
            <a class="btn btn-secondary" style="opacity:.6;pointer-events:none" title="Coming soon">+ Gmail — soon</a>
          </div>
          ${(hasFb || hasIg) && !canMultiChannel
            ? html`<p><small>Free includes one Facebook + one Instagram channel. More channels — and Telegram — are PRO.</small></p>`
            : ""}
          <div x-show="tg" x-cloak style="margin-top:.75rem">
            <p><small>In Telegram, message <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> → <code>/newbot</code> → copy the bot token. We register the webhook for you.</small></p>
            <form hx-post="/channels/telegram/connect" hx-ext="json-enc" hx-target="#channels-toast" hx-swap="innerHTML">
              <input name="token" placeholder="123456789:AA..." required />
              <button type="submit">Connect Telegram</button>
            </form>
          </div>
        </div>
        <h3>Connect a token manually</h3>
        <form hx-post="/channels/connect-token" hx-ext="json-enc" hx-target="#channels-toast" hx-swap="innerHTML">
          <select name="platform" aria-label="Platform"><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select>
          <input name="token" placeholder="paste long-lived / System User token" required />
          <button type="submit">Connect</button>
        </form>
        <div id="channels-toast"></div>`,
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
  return html`<section class="panel">
    <div class="panel-head"><h3>Token</h3></div>
    <dl class="meta-list">
      ${metaRow("Access token", html`<code class="token-mask">••••••••••••••••</code>`)}
      ${metaRow("Expires", expiryCell)}
      ${reasonRow}
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
  if (ch.connection_mode === "derived") return btn({ label: "Reconnect master", href: "/sources", variant: "primary", icon: "reconnect" });
  const start = oauthStartHref(ch.platform);
  if (ch.connection_mode === "oauth" && start) return btn({ label: "Reconnect", href: start, variant: "primary", icon: "reconnect" });
  return html``;
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
    ? html`<p class="muted" style="font-size:.82rem;margin:0 0 .5rem">
        Auto-posted as the first comment under every post published to this channel
        (e.g. “link in the comments 👇”). Leave empty to turn it off.
      </p>
      <form method="post" action="/channels/${ch.id}/first-comment"
        hx-post="/channels/${ch.id}/first-comment" hx-target="#ch-detail-head" hx-swap="outerHTML">
        <textarea name="firstComment" rows="3" maxlength="2000"
          placeholder="e.g. Grab the free guide → https://…"
          aria-label="Default first comment"
          style="width:100%;resize:vertical;font:inherit">${ch.default_first_comment ?? ""}</textarea>
        <div style="margin-top:.5rem">${btn({ label: "Save first comment", variant: "secondary", size: "sm" })}</div>
      </form>`
    : html`<p class="muted" style="font-size:.82rem;margin:0 0 .5rem">
        Auto-post a first comment (e.g. “link in the comments 👇”) under every post published to this channel.
      </p>
      <a class="btn btn-secondary btn-sm" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">🔒 First comment (PRO)</a>`;
  return html`<section class="panel" id="first-comment-panel"${oob ? raw(' hx-swap-oob="true"') : raw("")}>
    <div class="panel-head"><h3>First comment</h3></div>
    <div class="panel-body">${body}</div>
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
    ? html`<p class="muted" style="font-size:.82rem;margin:0 0 .5rem">
        Auto-publish a generated Story card (cover + caption) about every post published to this
        channel. ${on ? "Currently on." : "Currently off."}
      </p>
      <form method="post" action="/channels/${ch.id}/auto-story"
        hx-post="/channels/${ch.id}/auto-story" hx-target="#ch-detail-head" hx-swap="outerHTML">
        <input type="hidden" name="enabled" value="${on ? "0" : "1"}" />
        ${btn({ label: on ? "Turn off auto-Story" : "Turn on auto-Story", variant: on ? "danger" : "secondary", size: "sm" })}
      </form>`
    : html`<p class="muted" style="font-size:.82rem;margin:0 0 .5rem">
        Auto-publish a generated Story card (cover + caption) about every post published to this channel.
      </p>
      <a class="btn btn-secondary btn-sm" href="${upgradeUrl}" target="_blank" rel="noopener" style="opacity:.85" title="Requires a PRO license">🔒 Auto-Story (PRO)</a>`;
  return html`<section class="panel" id="story-panel"${oob ? raw(' hx-swap-oob="true"') : raw("")}>
    <div class="panel-head"><h3>Auto-Story</h3></div>
    <div class="panel-body">${body}</div>
  </section>`;
}

function manualReconnectForm(ch: PublicChannel): Html {
  if (ch.connection_mode !== "manual_token") return html``;
  return html`<h3>Reconnect — paste a fresh token</h3>
    <form method="post" action="/channels/${ch.id}/reconnect">
      <input name="token" placeholder="paste long-lived / System User token" required />
      <button type="submit">Reconnect</button>
    </form>`;
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
          ${handleBit}
          <code class="detail-acct">${ch.provider_account_id}</code>
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
              <div class="panel-body" style="display:flex;flex-wrap:wrap;gap:1.25rem">
                <div><div class="stat-n" style="font-size:1.4rem;font-weight:700">${stats.posts}</div><div class="muted" style="font-size:.72rem">Posts published</div></div>
                <div><div class="stat-n" style="font-size:1.4rem;font-weight:700">${stats.conversations}</div><div class="muted" style="font-size:.72rem">Conversations</div></div>
                <div><div class="stat-n" style="font-size:1.4rem;font-weight:700">${stats.messages}</div><div class="muted" style="font-size:.72rem">Messages</div></div>
                <div><div class="stat-n" style="font-size:1.4rem;font-weight:700">${stats.comments}</div><div class="muted" style="font-size:.72rem">Comments</div></div>
              </div></section>`
          : html`<section class="panel"><div class="panel-body muted" style="font-size:.82rem">📊 Channel stats (posts &amp; messages) are a PRO feature.</div></section>`}
        ${firstCommentPanel(ch, lic.features.has("first_comment"), lic.upgradeUrl)}
        ${storyPanel(ch, lic.features.has("auto_story"), lic.upgradeUrl)}
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
