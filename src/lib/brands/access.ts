// BRANDLIMIT1 — hybrid degradation of the per-tier brand limit. The limit was only enforced at
// CREATE time, so an instance that already had N brands (seed / migration / PRO→free downgrade) used
// them all on free. Hybrid rule: brands beyond `limitFor(tier,"brands")` (oldest-first) are LOCKED —
// still visible in the UI (with an upsell), but excluded from publish routing. A licensed tier
// (unlimited) locks nothing. This is the runtime authority, mirroring the auto_story/first_comment
// server-side gates — the UI lock is UX, this is enforcement.

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands } from "@/db/schema";
import { currentTier, limitFor } from "@/lib/license/gate";

/**
 * The set of brand keys that are LOCKED for this workspace under the current license. Active brands
 * are the oldest `limitFor` of them (stable order: created_at, then key); the rest are locked. An
 * unlimited tier returns an empty set (nothing locked).
 */
export async function lockedBrandKeys(workspaceId: string): Promise<Set<string>> {
  const limit = limitFor(await currentTier(), "brands");
  if (!Number.isFinite(limit)) return new Set();
  const all = await db.query.brands.findMany({
    where: eq(brands.workspace_id, workspaceId),
    orderBy: [asc(brands.created_at), asc(brands.key)],
    columns: { key: true },
  });
  return new Set(all.slice(limit).map((b) => b.key));
}

/** Whether a single brand is locked (beyond the tier's brand limit). */
export async function isBrandLocked(workspaceId: string, brandKey: string): Promise<boolean> {
  return (await lockedBrandKeys(workspaceId)).has(brandKey);
}
