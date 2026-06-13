import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountSources, channels } from "@/db/schema";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { env } from "@/lib/env";
import * as sourcesApi from "@/server/handlers/v1/sources/route";
import * as sourceApi from "@/server/handlers/v1/sources/[sourceId]/route";
import * as sourceSyncApi from "@/server/handlers/v1/sources/[sourceId]/sync/route";
import { renderPage } from "../layout";
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

function renderSources(srcs: Awaited<ReturnType<typeof loadSources>>, error?: string): Html {
  const notice = error ? html`<div class="auth-error">${error}</div>` : html``;
  if (srcs.length === 0) {
    return html`${notice}<p class="muted" style="font-size:.85rem">No managed connection yet. Paste a User or System User token above to auto-connect all your Pages and Instagram accounts.</p>`;
  }
  return html`${notice}<div class="list">${srcs.map((s) => {
    const broken = s.status === "needs_reauth";
    return html`<div class="list-row" style="flex-direction:column;align-items:stretch;gap:.5rem">
      <div class="row" style="align-items:center;gap:.5rem">
        <div class="grow">
          <div style="font-weight:600">${s.display_name ?? s.provider_account_id}
            ${broken ? html`<span style="color:var(--bad,#e5484d)"> · ⚠ Needs reconnect</span>` : html`<span class="muted"> · ✓ Active</span>`}
          </div>
          <div class="muted" style="font-size:.72rem">
            ${s.kind === "system_user" ? "System User (permanent)" : "User token"} ·
            ${s.channels.length} channel${s.channels.length === 1 ? "" : "s"} ·
            data access ${s.kind === "system_user" ? "never expires" : `until ${fmtDate(s.data_access_expires_at)}`} ·
            synced ${fmtDate(s.last_synced_at)}
          </div>
          ${broken && s.needs_reauth_reason ? html`<div class="muted" style="font-size:.72rem;color:var(--bad,#e5484d)">${s.needs_reauth_reason}</div>` : html``}
        </div>
        <button class="btn btn-sm btn-secondary" hx-post="/sources/${s.id}/sync" hx-target="#sources-list" hx-swap="innerHTML" title="Re-check for new Pages/Instagram now">↻ Sync</button>
        <button class="btn btn-sm btn-danger" hx-delete="/sources/${s.id}" hx-target="#sources-list" hx-swap="innerHTML" hx-confirm="Remove this managed connection? The connected channels stay, but stop auto-syncing.">Remove</button>
      </div>
      <div class="list" style="margin-left:.5rem">${s.channels.map(
        (c) => html`<div class="row" style="align-items:center;gap:.5rem;font-size:.8rem">
          ${c.profile_picture ? html`<img class="avatar" src="${c.profile_picture}" alt="" style="width:20px;height:20px" />` : html``}
          <span>${platformLabel(c.platform)}</span>
          <span class="grow">${c.display_name ?? c.platform_id}${c.username ? html` · <span class="muted">@${c.username}</span>` : html``}
            <span class="muted" style="font-size:.7rem"> · id ${c.platform_id}</span>
            ${c.status === "needs_reauth" ? html`<span style="color:var(--bad,#e5484d)"> · ⚠</span>` : html``}
            <span class="muted">${expiryNote(c.token_expires_at, c.data_access_expires_at)}</span>
          </span>
        </div>`,
      )}</div>
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

function metaConfigRow(label: string, value: string): Html {
  return html`<div class="meta-row"><dt>${label}</dt><dd><code class="meta-mono">${value}</code></dd></div>`;
}

async function sourcesPage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const lic = await getInstanceLicense();
  const canManaged = lic.features.has("managed_connection");
  const srcs = canManaged ? await loadSources(a.workspaceId) : [];

  return c.html(
    renderPage({
      title: "Sources",
      nav: "sources",
      features: lic.features,
      products: lic.products,
      breadcrumb: "Managed connection",
      body: html`<p class="section-intro">One master token connects <strong>all</strong> your Pages + Instagram accounts at once, auto-syncs new ones, and warns you before access expires.</p>
        ${canManaged
          ? html`<section class="panel">
              <div class="panel-head"><h3>Connect a master token</h3></div>
              <div x-data="{ guide: false }">
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
              </div>
            </section>`
          : html`<div class="banner banner-pro panel" style="padding:1rem">
              <strong>PRO feature</strong> — a managed connection connects one master FB/IG token and auto-enumerates all your Pages + linked Instagram accounts.
              <a class="btn btn-primary btn-sm" href="${lic.upgradeUrl}" target="_blank" rel="noopener">Upgrade →</a>
            </div>`}
        <section class="panel" style="margin-top:1rem">
          <div class="panel-head"><h3>App setup — OAuth redirect / callback URLs</h3></div>
          <dl class="meta-list">
            ${metaConfigRow("OAuth Redirect URI — Facebook", `${env.APP_URL}/api/oauth/facebook/callback`)}
            ${metaConfigRow("OAuth Redirect URI — Instagram", `${env.APP_URL}/api/oauth/instagram/callback`)}
            ${metaConfigRow("Authorized redirect URI — YouTube", `${env.APP_URL}/api/oauth/youtube/callback`)}
            ${metaConfigRow("Webhook callback URL — Meta", `${env.APP_URL}/api/webhooks/meta`)}
          </dl>
        </section>`,
    }),
  );
}

export function registerSources(r: Hono, guard: MiddlewareHandler): void {
  r.get("/sources", guard, sourcesPage);

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
