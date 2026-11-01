import { html, raw } from "hono/html";
import type { Hono, MiddlewareHandler } from "hono";
import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { conversations, pendingApprovals, channels } from "@/db/schema";
import { createTtlCache } from "@/lib/cache/ttl-cache";
import { authenticate } from "@/lib/auth";
import { COUNT_KEYS } from "./nav";

export type NavCounts = Record<(typeof COUNT_KEYS)[number], number>;

// Short per-workspace memo: the badges load on every page view, the numbers need not be to-the-second.
const cache = createTtlCache<NavCounts>({ ttlMs: Math.min(env.STATS_CACHE_TTL_MS, 15_000) });

/** Inbox = open conversations with unread messages; Approvals = pending drafts; Channels = need re-auth. */
export function loadNavCounts(workspaceId: string): Promise<NavCounts> {
  return cache.getOrCompute(workspaceId, async () => {
    const n = async (q: PromiseLike<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const [inbox, approvals, channelsBad] = await Promise.all([
      n(db.select({ n: count() }).from(conversations).where(and(eq(conversations.workspace_id, workspaceId), eq(conversations.status, "open"), gt(conversations.unread_count, 0)))),
      n(db.select({ n: count() }).from(pendingApprovals).where(and(eq(pendingApprovals.workspace_id, workspaceId), eq(pendingApprovals.status, "pending")))),
      n(db.select({ n: count() }).from(channels).where(and(eq(channels.workspace_id, workspaceId), eq(channels.status, "needs_reauth")))),
    ]);
    return { inbox, approvals, channels: channelsBad };
  });
}

/** Empty badge placeholder (hidden by `.n:empty`); the fragment below fills it. `m` = phone bar. */
export function navBadge(key: string, mobile = false) {
  return html`<span id="${mobile ? "mnav-n-" : "nav-n-"}${key}" class="n${key === "channels" ? " bad" : ""}"></span>`;
}

/** Out-of-band htmx swap filling every badge (sidebar + phone bar); 0 renders empty = hidden. */
export function navCountsFragment(c: NavCounts) {
  return html`${COUNT_KEYS.flatMap((k) => ["nav-n-", "mnav-n-"].map((pre) => {
    const cls = `n${k === "channels" ? " bad" : ""}`;
    return html`<span id="${pre}${k}" class="${cls}" hx-swap-oob="true">${c[k] > 99 ? "99+" : c[k] > 0 ? String(c[k]) : ""}</span>`;
  }))}`;
}

/** The hidden loader mounted once in the shell; refreshes on load and when the tab regains focus. */
export const navCountsLoader = raw('<div hidden hx-get="/nav/counts" hx-trigger="load, visibilitychange[document.visibilityState==\'visible\'] from:document" hx-swap="none"></div>');

export function registerNavCounts(app: Hono, guard: MiddlewareHandler): void {
  app.get("/nav/counts", guard, async (c) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return c.body("", 401);
    c.header("Cache-Control", "private, no-store");
    return c.html(navCountsFragment(await loadNavCounts(a.workspaceId)));
  });
}
