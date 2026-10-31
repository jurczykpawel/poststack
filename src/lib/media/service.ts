import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { media } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
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

async function fillMissingDuration(row: MediaRow, durationSec?: number): Promise<MediaRow> {
  if (row.kind !== "video" || row.duration_sec != null || durationSec == null) return row;
  const [updated] = await db.update(media).set({ duration_sec: durationSec })
    .where(and(eq(media.id, row.id), eq(media.workspace_id, row.workspace_id), isNull(media.duration_sec)))
    .returning();
  return updated ?? (await getMedia(row.id, row.workspace_id)) ?? row;
}


const fetchTimeoutMs = (): number => Number(process.env.MEDIA_FETCH_TIMEOUT_MS ?? 3_600_000);

export interface RegisterByUrlDeps {
  storage: Storage;
  probe: Prober;
  resolve?: (host: string) => Promise<string[]>;
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
      // CAS dedup at the media-row level (per workspace): identical content → existing row.
      const existing = await db.query.media.findFirst({
        where: and(eq(media.workspace_id, workspaceId), eq(media.checksum, checksum)),
      });
      if (existing) {
        if (existing.kind !== "video" || existing.duration_sec != null) return existing;
        return fillMissingDuration(existing, (await ingestStage("probe", () => deps.probe(prefix, headerMime, file))).durationSec);
      }

      const probe = await ingestStage("probe", () => deps.probe(prefix, headerMime, file));
      const mime = probe.mime ?? headerMime;
      const key = casKey(checksum, mime);

      // CAS dedup at the object level: only upload if not already present.
      await ingestStage("upload", async () => {
        if (!(await deps.storage.head(key)).exists) {
          await deps.storage.copy(temporary, key, mime ?? "application/octet-stream", { sha256: checksum });
        }
      });

      // Row-level CAS: a concurrent identical ingest can insert between the findFirst and here.
      // onConflictDoNothing + re-select makes the loser resolve to the winner (PSA34) — scoped to
      // the (workspace_id, checksum) unique so it's per-tenant.
      const [row] = await db
        .insert(media)
        .values({
          workspace_id: workspaceId,
          checksum,
          storage_key: key,
          url: deps.storage.publicUrl(key),
          kind: probe.kind,
          mime: mime ?? null,
          size,
          width: probe.width ?? null,
          height: probe.height ?? null,
          duration_sec: probe.durationSec ?? null,
          status: "ready",
        })
        .onConflictDoNothing({ target: [media.workspace_id, media.checksum] })
        .returning();
      if (row) return row;
      return (await db.query.media.findFirst({
        where: and(eq(media.workspace_id, workspaceId), eq(media.checksum, checksum)),
      }))!;
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
 * is present via a storage HEAD and links a DB row — never fetches bytes or re-uploads. CAS dedup is
 * PER workspace (checksum unique per workspace_id), mirroring registerByUrl. Throws
 * ApiError("not_present", …, 422) when the object is absent so the caller can fall back to
 * registerByUrl (a missing dependency object is an unprocessable request, not a 409 conflict).
 */
export async function registerKnownMedia(
  m: KnownMedia,
  deps: { storage: Storage },
  workspaceId: string,
): Promise<MediaRow> {
  // CAS dedup (per workspace): identical checksum already linked here → return without storage I/O.
  const existing = await db.query.media.findFirst({
    where: and(eq(media.workspace_id, workspaceId), eq(media.checksum, m.checksum)),
  });
  if (existing) return fillMissingDuration(existing, m.durationSec);

  const key = casKey(m.checksum, m.mime);

  // Verify the object is actually present — the caller (or ReelStack) must have uploaded it first.
  if (!(await deps.storage.head(key)).exists) {
    throw new ApiError("not_present", `Object ${key} not present in media bucket`, 422);
  }

  // Row-level CAS scoped to (workspace_id, checksum): a concurrent registration can race past
  // findFirst. onConflictDoNothing + re-select mirrors registerByUrl (PSA34).
  const [row] = await db
    .insert(media)
    .values({
      workspace_id: workspaceId,
      checksum: m.checksum,
      storage_key: key,
      url: deps.storage.publicUrl(key),
      kind: m.kind,
      mime: m.mime ?? null,
      size: m.size ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      duration_sec: m.durationSec ?? null,
      status: "ready",
    })
    .onConflictDoNothing({ target: [media.workspace_id, media.checksum] })
    .returning();
  if (row) return row;
  return (await db.query.media.findFirst({
    where: and(eq(media.workspace_id, workspaceId), eq(media.checksum, m.checksum)),
  }))!;
}
