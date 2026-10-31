import { randomUUID } from "node:crypto";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { media } from "@/db/schema";
import { addJobTx } from "@/lib/queue/client";
import { getStorage } from "@/lib/storage";
import { defaultProbe } from "./probe";
import { getMedia, registerByUrl } from "./service";

export async function enqueueIngest(url: string, workspaceId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId + url}, 0))`);
    const existing = await tx.query.media.findFirst({ where: and(
      eq(media.workspace_id, workspaceId), eq(media.source_url, url), eq(media.status, "ingesting"),
    ) });
    if (existing) return existing;
    const id = randomUUID();
    const [row] = await tx.insert(media).values({
      id, workspace_id: workspaceId, checksum: `pending:${id}`, source_url: url,
      storage_key: "", url: "", kind: "", status: "ingesting",
    }).returning();
    await addJobTx(tx, "media-ingest", { id, workspaceId }, { jobKey: `media:${id}` });
    return row;
  });
}

export async function processMediaIngest({ id, workspaceId }: { id: string; workspaceId: string }) {
  const row = await getMedia(id, workspaceId);
  if (!row || row.status !== "ingesting" || !row.source_url) return;
  try {
    const ready = await registerByUrl(row.source_url, { storage: getStorage(), probe: defaultProbe }, workspaceId);
    // Keep the accepted handle stable when CAS resolves to an existing media row.
    await db.update(media).set({ canonical_id: ready.id, status: "ready", error: null })
      .where(and(eq(media.id, id), eq(media.workspace_id, workspaceId)));
  } catch (e) {
    const reason = (e instanceof Error ? e.message : "Media ingest failed").slice(0, 1000);
    await db.update(media).set({ status: "failed", error: reason })
      .where(and(eq(media.id, id), eq(media.workspace_id, workspaceId)));
    console.error(`[media-ingest] ${id}: ${sanitizeForLog(reason)}`);
  }
}
