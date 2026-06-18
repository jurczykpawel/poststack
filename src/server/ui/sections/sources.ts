import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountSources, channels } from "@/db/schema";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import * as sourcesApi from "@/server/handlers/v1/sources/route";
import * as sourceApi from "@/server/handlers/v1/sources/[sourceId]/route";
import * as sourceSyncApi from "@/server/handlers/v1/sources/[sourceId]/sync/route";
import { platformLabel } from "../components/platform";

type Html = ReturnType<typeof html>;

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

/** Soonest expiry hint for a derived channel (token-death / 90-day data-access clock). */
function expiryNote(tokenExpiresAt: Date | null, dataAccessExpiresAt: Date | null): string {
  const dates = [tokenExpiresAt, dataAccessExpiresAt].filter((d): d is Date => d instanceof Date);
  if (dates.length === 0) return "";
  const soonest = dates.reduce((a, b) => (a < b ? a : b));
  const days = Math.ceil((soonest.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return " · ⛔ access expired — reconnect";
  if (days <= 14) return ` · ⏳ expires in ${days} day${days === 1 ? "" : "s"}`;
  return "";
}

async function loadSources(workspaceId: string) {
  const rows = await db.query.accountSources.findMany({
    where: eq(accountSources.workspace_id, workspaceId),
    orderBy: asc(accountSources.created_at),
    columns: {
      id: true, provider_account_id: true, display_name: true, kind: true, status: true,
      needs_reauth_reason: true, data_access_expires_at: true, last_synced_at: true,
    },
  });
  const ids = rows.map((r) => r.id);
  const derived = ids.length
    ? await db.query.channels.findMany({
        where: and(eq(channels.workspace_id, workspaceId), inArray(channels.source_id, ids)),
        columns: {
          id: true, source_id: true, platform: true, platform_id: true, display_name: true,
          username: true, profile_picture: true, status: true, token_expires_at: true, data_access_expires_at: true,
        },
      })
    : [];
  return rows.map((s) => ({ ...s, channels: derived.filter((c) => c.source_id === s.id) }));
}

type DerivedChannel = Awaited<ReturnType<typeof loadSources>>[number]["channels"][number];

/** One channel line under a source's platform group: avatar · name · @handle · id · expiry. */
function sourceChannelLine(c: DerivedChannel): Html {
  return html`<div class="row" style="align-items:center;gap:.5rem;font-size:.8rem">
    ${c.profile_picture ? html`<img class="avatar" src="${c.profile_picture}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" style="width:22px;height:22px" />` : html``}
    <span class="grow">${c.display_name ?? c.platform_id}${c.username ? html` · <span class="muted">@${c.username}</span>` : html``}
      <span class="muted" style="font-size:.7rem"> · id ${c.platform_id}</span>
      ${c.status === "needs_reauth" ? html`<span style="color:var(--bad-text)"> · ⚠</span>` : html``}
      <span class="muted">${expiryNote(c.token_expires_at, c.data_access_expires_at)}</span>
    </span>
  </div>`;
}

function renderSources(srcs: Awaited<ReturnType<typeof loadSources>>, error?: string): Html {
  const notice = error ? html`<div class="auth-error">${error}</div>` : html``;
  if (srcs.length === 0) {
    return html`${notice}<p class="muted" style="font-size:.85rem">No managed connection yet. Paste a User or System User token above to auto-connect all your Pages and Instagram accounts.</p>`;
  }
  return html`${notice}<div class="list" style="gap:.75rem">${srcs.map((s) => {
    const broken = s.status === "needs_reauth";
    // Group the source's derived channels by platform so a 60-channel token reads as a few
    // collapsible sections instead of one flat wall. Large groups start collapsed.
    const groups = new Map<string, DerivedChannel[]>();
    for (const c of s.channels) (groups.get(c.platform) ?? groups.set(c.platform, []).get(c.platform)!).push(c);
    const groupEntries = [...groups.entries()].sort((a, b) => platformLabel(a[0]).localeCompare(platformLabel(b[0])));
    return html`<div class="list-row" style="flex-direction:column;align-items:stretch;gap:.5rem">
      <div class="row" style="align-items:center;gap:.5rem">
        <div class="grow">
          <div style="font-weight:600">${s.display_name ?? s.provider_account_id}
            ${broken ? html`<span style="color:var(--bad-text)"> · ⚠ Needs reconnect</span>` : html`<span class="muted"> · ✓ Active</span>`}
          </div>
          <div class="muted" style="font-size:.72rem">
            ${s.kind === "system_user" ? "System User (permanent)" : "User token"} ·
            ${s.channels.length} channel${s.channels.length === 1 ? "" : "s"} across ${groupEntries.length} platform${groupEntries.length === 1 ? "" : "s"} ·
            data access ${s.kind === "system_user" ? "never expires" : `until ${fmtDate(s.data_access_expires_at)}`} ·
            synced ${fmtDate(s.last_synced_at)}
          </div>
          ${broken && s.needs_reauth_reason ? html`<div class="muted" style="font-size:.72rem;color:var(--bad-text)">${s.needs_reauth_reason}</div>` : html``}
        </div>
        <button class="btn btn-sm btn-secondary" hx-post="/sources/${s.id}/sync" hx-target="#sources-list" hx-swap="innerHTML" title="Re-check for new Pages/Instagram now">↻ Sync</button>
        <button class="btn btn-sm btn-danger" hx-delete="/sources/${s.id}" hx-target="#sources-list" hx-swap="innerHTML" hx-confirm="Remove this managed connection? The connected channels stay, but stop auto-syncing.">Remove</button>
      </div>
      ${s.channels.length === 0
        ? html`<p class="muted" style="font-size:.78rem;margin:0">No channels found under this token yet — try ↻ Sync.</p>`
        : html`<div class="stack" style="gap:.3rem;margin-left:.25rem">${groupEntries.map(([platform, chans]) => {
            const needs = chans.filter((c) => c.status === "needs_reauth").length;
            return html`<details ${chans.length <= 8 ? raw("open") : raw("")}>
              <summary style="cursor:pointer;font-size:.82rem;font-weight:600">${platformLabel(platform)} <span class="muted" style="font-weight:400">· ${chans.length}</span>${needs ? html` <span style="color:var(--bad-text);font-weight:400">· ${needs} need reconnect</span>` : ""}</summary>
              <div class="list" style="margin:.3rem 0 .25rem .5rem;gap:.2rem">${chans.map(sourceChannelLine)}</div>
            </details>`;
          })}</div>`}
    </div>`;
  })}</div>`;
}

/** Build an error notice from a delegated API response, or undefined on success. */
async function noticeFrom(res: Response | null, fallback: string): Promise<string | undefined> {
  if (res && res.status < 400) return undefined;
  if (!res) return fallback;
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

/** The managed-connection (sources) manager body — rendered inside the Settings → Sources tab.
 *  PRO-gated; on free it shows an upgrade prompt. The app-setup OAuth/callback URLs are NOT
 *  duplicated here — they live in Settings → Integrations. */
export async function renderSourcesManager(workspaceId: string): Promise<Html> {
  const lic = await getInstanceLicense();
  const canManaged = lic.features.has("managed_connection");
  const srcs = canManaged ? await loadSources(workspaceId) : [];
  return html`<p class="muted" style="margin-bottom:1rem">One master token connects <strong>all</strong> your Pages + Instagram accounts at once, auto-syncs new ones, and warns you before access expires.</p>
    ${canManaged
      ? html`<div x-data="{ guide: false }">
          <form hx-post="/sources" hx-ext="json-enc" hx-target="#sources-list" hx-swap="innerHTML">
            <textarea class="textarea mono" name="token" rows="3" placeholder="Paste a User or System User access token" required></textarea>
            <div class="row" style="gap:.5rem">
              <button class="btn btn-primary" type="submit">Connect all</button>
              <button class="btn btn-sm btn-secondary" type="button" @click="guide = !guide">How do I get a permanent token?</button>
            </div>
          </form>
          <div x-show="guide" x-cloak class="panel" style="margin-top:.75rem;font-size:.8rem;line-height:1.5;padding:.75rem">
            <strong>Generate a permanent System User token (never expires):</strong>
            <ol style="margin:.4rem 0 0 1rem;padding:0">
              <li>Open <a href="https://business.facebook.com/settings" target="_blank" rel="noopener">Business Manager → Business settings</a>.</li>
              <li>Users → <strong>System Users</strong> → Add → create an <em>Admin</em> system user.</li>
              <li>Assign your Pages (and linked Instagram accounts) to it with full control.</li>
              <li>Click <strong>Generate new token</strong>, pick this app, set expiry to <strong>Never</strong>.</li>
              <li>Grant scopes: <code>pages_show_list</code>, <code>pages_messaging</code>, <code>pages_read_engagement</code>, <code>pages_manage_metadata</code>, <code>instagram_basic</code>, <code>instagram_manage_messages</code>, <code>instagram_manage_comments</code>.</li>
              <li>Copy the token and paste it above.</li>
            </ol>
          </div>
          <div id="sources-list" style="margin-top:1rem">${renderSources(srcs)}</div>
        </div>`
      : html`<div class="banner banner-pro panel" style="padding:1rem">
          <strong>PRO feature</strong> — a managed connection connects one master FB/IG token and auto-enumerates all your Pages + linked Instagram accounts.
          <a class="btn btn-primary btn-sm" href="${lic.upgradeUrl}" target="_blank" rel="noopener">Upgrade →</a>
        </div>`}`;
}

export function registerSources(r: Hono, guard: MiddlewareHandler): void {
  // Managed connections now live in Settings → Sources; keep the path as a redirect so existing
  // links ("Reconnect master →", deep links) land on the tab. The POST/sync/delete endpoints stay.
  r.get("/sources", guard, (c) => c.redirect("/settings#sources"));

  r.post("/sources", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const res = await sourcesApi.POST(c.req.raw);
    return c.html(renderSources(await loadSources(a.workspaceId), await noticeFrom(res, "Could not connect this token.")));
  });

  r.post("/sources/:id/sync", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const res = await sourceSyncApi.POST(c.req.raw, { params: Promise.resolve({ sourceId: c.req.param("id") }) }).catch(() => null);
    return c.html(renderSources(await loadSources(a.workspaceId), await noticeFrom(res, "Could not sync this connection.")));
  });

  r.delete("/sources/:id", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const res = await sourceApi.DELETE(c.req.raw, { params: Promise.resolve({ sourceId: c.req.param("id") }) }).catch(() => null);
    return c.html(renderSources(await loadSources(a.workspaceId), await noticeFrom(res, "Could not remove this connection.")));
  });
}
