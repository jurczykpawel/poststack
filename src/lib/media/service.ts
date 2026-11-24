import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, media, deliveries, posts, postPreviews, outboundDeliveries } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { getProviderForPlatform, isPublishablePlatform } from "@/lib/providers";
import type { Storage } from "@/lib/storage/types";
import { safeFetch, SsrfError } from "./ssrf";
import { casKey } from "./cas";
import { ingestStage, ingestStream } from "./ingest-stream";
import { withIngestSlot } from "./ingest-limit";

export interface ProbeResult {
  kind: "video" | "image";
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
}
export type Prober = (bytes: Uint8Array, mime: string | undefined, file?: string) => Promise<ProbeResult>;

export type MediaRow = typeof media.$inferSelect;
type MediaTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function lockBlob(tx: MediaTx, key: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function fillMissingDuration(tx: MediaTx, row: MediaRow, durationSec?: number): Promise<MediaRow> {
  if (row.kind !== "video" || row.duration_sec != null || durationSec == null) return row;
  const [updated] = await tx.update(media).set({ duration_sec: durationSec })
    .where(and(eq(media.id, row.id), eq(media.workspace_id, row.workspace_id), isNull(media.duration_sec)))
    .returning();
  return updated ?? row;
}

const fetchTimeoutMs = (): number => Number(process.env.MEDIA_FETCH_TIMEOUT_MS ?? 3_600_000);

export interface RegisterByUrlDeps {
  storage: Storage;
  probe: Prober;
  resolve?: (host: string) => Promise<string[]>;
  handleId?: string;
}

/**
 * Ingest a caller-supplied media URL into content-addressed storage, scoped to a workspace. CAS dedup
 * is PER workspace (checksum unique per workspace_id) so two tenants ingesting identical bytes each
 * get their own row — no cross-tenant leak via a shared content address.
 */
export async function registerByUrl(
  url: string,
  deps: RegisterByUrlDeps,
  workspaceId: string,
): Promise<MediaRow> {
  // Bound concurrent transfers and temporary disk usage.
  return withIngestSlot(async () => {
    // SSRF guard + redirect-safe fetch via the single chokepoint; refusal → 400, not a leaked 500.
    let res: Response;
    try {
      res = await safeFetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs()) }, { resolve: deps.resolve });
    } catch (e) {
      if (e instanceof SsrfError) throw new ApiError("invalid_url", e.message, 400);
      throw new ApiError("ingest_failed", `download: Could not fetch media: ${e instanceof Error ? e.message : "fetch failed"}`, 400);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ApiError("ingest_failed", `download: Could not fetch media: ${res.status}`, 400);
    }
    const headerMime = res.headers.get("content-type")?.split(";")[0]?.trim();
    return ingestStream(res, deps.storage, async ({ checksum, size, prefix, file, temporary }) => {
      const existing = await db.query.media.findFirst({
        where: and(eq(media.workspace_id, workspaceId), eq(media.checksum, checksum)),
      });
      const probe: ProbeResult = existing?.kind === "image" || (existing?.kind === "video" && existing.duration_sec != null)
        ? { kind: existing.kind, mime: existing.mime ?? undefined, width: existing.width ?? undefined,
          height: existing.height ?? undefined, durationSec: existing.duration_sec ?? undefined }
        : await ingestStage("probe", () => deps.probe(prefix, headerMime, file));
      return ingestStage("upload", () => registerKnownMedia(
        { ...probe, checksum, size, mime: probe.mime ?? headerMime },
        { storage: deps.storage, temporary, handleId: deps.handleId }, workspaceId,
      ));
    });
  });
}

export async function getMedia(id: string, workspaceId: string): Promise<MediaRow | undefined> {
  const row = await db.query.media.findFirst({
    where: and(eq(media.id, id), eq(media.workspace_id, workspaceId)),
  });
  if (!row?.canonical_id) return row;
  const canonical = await db.query.media.findFirst({
    where: and(eq(media.id, row.canonical_id), eq(media.workspace_id, workspaceId)),
  });
  return canonical ? { ...canonical, id: row.id, created_at: row.created_at, source_url: row.source_url, canonical_id: row.canonical_id } : row;
}

// ---------------------------------------------------------------------------
// registerKnownMedia — link a content-addressed object by reference (no re-upload)
// ---------------------------------------------------------------------------

export interface KnownMedia {
  checksum: string;
  mime?: string;
  kind: "video" | "image";
  size?: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

/**
 * Register media that ALREADY lives in the content-addressed bucket (e.g. a reel rendered by
 * ReelStack into the shared `tsa-media-public` bucket), scoped to a workspace. Verifies the object
 * is present via a storage HEAD and links a DB row. Uploads can supply a temporary object to copy
 * into CAS if the key is missing. CAS dedup is PER workspace (checksum unique per workspace_id). Throws
 * ApiError("not_present", …, 422) when the object is absent so the caller can fall back to
 * registerByUrl (a missing dependency object is an unprocessable request, not a 409 conflict).
 */
export async function registerKnownMedia(
  m: KnownMedia,
  deps: { storage: Storage; temporary?: string; handleId?: string },
  workspaceId: string,
): Promise<MediaRow> {
  const { storage, temporary, handleId } = deps;
  const key = casKey(m.checksum, m.mime);
  const register = () => db.transaction(async tx => {
    await lockBlob(tx, key);
    const byChecksum = and(eq(media.workspace_id, workspaceId), eq(media.checksum, m.checksum));
    let row = await tx.query.media.findFirst({ where: byChecksum });
    if ((!row || (temporary && key === row.storage_key)) && !(await storage.head(key)).exists) return;
    if (row) {
      row = await fillMissingDuration(tx, row, m.durationSec);
    } else {
      const [inserted] = await tx.insert(media).values({
        workspace_id: workspaceId,
        checksum: m.checksum,
        storage_key: key,
        url: storage.publicUrl(key),
        kind: m.kind,
        mime: m.mime ?? null,
        size: m.size ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        duration_sec: m.durationSec ?? null,
        status: "ready",
      }).onConflictDoNothing({ target: [media.workspace_id, media.checksum] }).returning();
      row = inserted ?? (await tx.query.media.findFirst({ where: byChecksum }))!;
    }
    if (handleId) await tx.update(media).set({ canonical_id: row.id, status: "ready", error: null })
      .where(and(eq(media.id, handleId), eq(media.workspace_id, workspaceId), eq(media.status, "ingesting")));
    return row;
  });

  let row = await register();
  // Release the transaction during the copy. DELETE can remove the object before the next HEAD.
  for (let attempt = 0; !row && temporary && attempt < 2; attempt++) {
    await storage.copy(temporary, key, m.mime ?? "application/octet-stream", { sha256: m.checksum });
    row = await register();
  }
  if (row) return row;
  if (!temporary) throw new ApiError("not_present", `Object ${key} not present in media bucket`, 422);
  throw new ApiError("conflict", "Media changed during registration. Retry the upload.", 409);
}

// Keep the media rows stable until the delivery's media IDs have been written to its payload.
export async function lockDeliveryMedia(tx: MediaTx, workspaceId: string, mediaIds: string[], coverUrl?: unknown) {
  const scope = eq(media.workspace_id, workspaceId);
  const covers = typeof coverUrl === "string" && coverUrl ? await tx.select({ id: media.id }).from(media)
    .where(and(scope, eq(media.url, coverUrl))) : [];
  const ids = [...new Set([...mediaIds.map(id => id.toLowerCase()), ...covers.map(row => row.id)])];
  if (!ids.length) return;
  const rows = await tx.select({ id: media.id }).from(media)
    .where(and(scope, inArray(media.id, ids))).orderBy(media.id).for("key share");
  const found = new Set(rows.map(row => row.id));
  const missing = ids.find(id => !found.has(id));
  if (missing) throw new ApiError("invalid_request", `Unknown media: ${missing}`, 422);
}

export function listReadyMedia(workspaceId: string) {
  return db.query.media.findMany({ where: and(eq(media.workspace_id, workspaceId), eq(media.status, "ready"), isNull(media.canonical_id)), orderBy: [desc(media.created_at), desc(media.id)], limit: 100, columns: { id: true, url: true, kind: true } });
}

export async function deleteMedia(id: string, deps: { storage: Storage }, workspaceId: string) {
  const scope = eq(media.workspace_id, workspaceId);
  const target = and(scope, eq(media.id, id));
  return db.transaction(async tx => {
    const existing = await tx.query.media.findFirst({ where: target, columns: { storage_key: true } });
    if (!existing) throw new ApiError("not_found", "Media not found", 404);
    if (existing.storage_key) await lockBlob(tx, existing.storage_key);

    const related = await tx.select().from(media)
      .where(and(scope, or(eq(media.id, id), eq(media.canonical_id, id)))).orderBy(media.id).for("update");
    const row = related.find(m => m.id === id);
    if (!row) throw new ApiError("not_found", "Media not found", 404);
    const ids = sql.param(related.map(m => m.id));
    const url = row.canonical_id ? null : row.url || null;
    const pullUrlFormats = channels.platform.enumValues.filter(isPublishablePlatform).flatMap(platform =>
      getProviderForPlatform(platform).capabilities(platform)
        .filter(cap => cap.mediaIngestion === "pull_url" && cap.media.max > 0)
        .map(cap => sql`(${platform}, ${cap.format})`));
    const blockers = await tx.execute<{ post_id: string | null; delivery_id: string | null; status: string }>(sql`
      select p.id as post_id, d.id as delivery_id, d.status from ${deliveries} d
      left join ${posts} p on p.delivery_id = d.id and p.workspace_id = d.workspace_id
      where d.workspace_id = ${workspaceId}
      and (((d.status not in ('sent', 'canceled') or (
        d.status = 'sent' and d.sent_at > (now() at time zone 'UTC') - interval '1 hour'
        and exists (select 1 from ${channels} c where c.id = d.channel_id and c.workspace_id = d.workspace_id
          and (c.platform::text, d.format) in (${sql.join(pullUrlFormats, sql`, `)}))
      )) and (
        exists (select 1 from jsonb_array_elements_text(jsonb_path_query_array(d.payload, '$.media[*].mediaId')) item
          where lower(item) = any(${ids}::text[]))
        or d.payload->'options'->>'coverUrl' = ${url}
      )) or (d.status = 'sent' and lower(d.payload->'media'->0->>'mediaId') = any(${ids}::text[]) and (
        exists (select 1 from graphile_worker.jobs j where j.key = 'auto-story:' || d.id
          and (j.locked_at is not null or j.attempts < j.max_attempts))
        or exists (select 1 from ${outboundDeliveries} o where o.workspace_id = d.workspace_id
          and o.delivery_key = 'auto-story:' || d.id and o.status in ('held', 'sending'))
      )))
      union all
      select p.id, null, 'scheduled' from ${posts} p
      where p.workspace_id = ${workspaceId} and p.delivery_id is null and p.status = 'scheduled'
      and (${url} in (p.media_url, p.video_url, p.cover_url) or p.media_urls ? ${url})
    `);
    if (blockers.rows.length) {
      const names = blockers.rows.map(p => p.post_id ? `post ${p.post_id}` : `delivery ${p.delivery_id}`);
      const statuses = new Set(blockers.rows.map(blocker => blocker.status));
      const message = [`Media is in use by ${names.join(", ")}.`];
      if (["scheduled", "held", "failed", "unknown"].some(status => statuses.has(status))) message.push("Cancel the post to delete the file.");
      if (statuses.has("sending") || statuses.has("processing")) message.push("Wait for publishing to finish before deleting the file.");
      if (statuses.has("sent")) message.push("Wait until one hour after publication and until any automatic Story has finished before deleting the file.");
      throw new ApiError("conflict", message.join(" "), 409);
    }
    if (row.status === "ingesting") throw new ApiError("conflict", "Wait for media ingestion to finish before deleting it.", 409);

    await tx.delete(media).where(target);
    if (!row.storage_key || row.canonical_id) return;
    // Object ownership spans workspaces. Only this workspace's media rows are removed.
    const refs = await tx.select({ found: sql`1` }).from(media).where(eq(media.storage_key, row.storage_key))
      .unionAll(tx.select({ found: sql`1` }).from(postPreviews).where(or(
        eq(postPreviews.image_url, row.url), eq(postPreviews.image_url, deps.storage.publicUrl(row.storage_key)),
      ))).limit(1);
    if (!refs.length) await deps.storage.delete(row.storage_key);
  });
}
