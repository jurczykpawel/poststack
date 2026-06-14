import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { media } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import type { Storage } from "@/lib/storage/types";
import { safeFetch, SsrfError } from "./ssrf";
import { sha256Hex, casKey } from "./cas";
import { readBodyCapped } from "./read-capped";
import { withIngestSlot } from "./ingest-limit";

export interface ProbeResult {
  kind: "video" | "image";
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
}
export type Prober = (bytes: Uint8Array, mime: string | undefined) => Promise<ProbeResult>;

export type MediaRow = typeof media.$inferSelect;

// PSA32: realistic platform-max default (overridable), paired with the ingest semaphore + fetch timeout.
const MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 256 * 1024 * 1024);
const fetchTimeoutMs = (): number => Number(process.env.MEDIA_FETCH_TIMEOUT_MS ?? 60_000);

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
  // PSA32: hold one bounded ingest slot for the whole memory-resident lifetime of `buf`.
  return withIngestSlot(async () => {
    // SSRF guard + redirect-safe fetch via the single chokepoint; refusal → 400, not a leaked 500.
    let res: Response;
    try {
      res = await safeFetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs()) }, { resolve: deps.resolve });
    } catch (e) {
      if (e instanceof SsrfError) throw new ApiError("invalid_url", e.message, 400);
      throw new ApiError("ingest_failed", `Could not fetch media: ${e instanceof Error ? e.message : "fetch failed"}`, 400);
    }
    if (!res.ok) throw new ApiError("ingest_failed", `Could not fetch media: ${res.status}`, 400);
    // Hard byte cap independent of Content-Length (AUD44/63) — no unbounded buffering.
    const buf = await readBodyCapped(res, MAX_BYTES);

    const headerMime = res.headers.get("content-type")?.split(";")[0]?.trim();
    const checksum = sha256Hex(buf);

    // CAS dedup at the media-row level (per workspace): identical content → existing row.
    const existing = await db.query.media.findFirst({
      where: and(eq(media.workspace_id, workspaceId), eq(media.checksum, checksum)),
    });
    if (existing) return existing;

    const probe = await deps.probe(buf, headerMime);
    const mime = probe.mime ?? headerMime;
    const key = casKey(checksum, mime);

    // CAS dedup at the object level: only upload if not already present.
    if (!(await deps.storage.head(key)).exists) {
      await deps.storage.putBytes(key, buf, mime ?? "application/octet-stream", { sha256: checksum });
    }

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
        size: buf.byteLength,
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
}

export async function getMedia(id: string, workspaceId: string): Promise<MediaRow | undefined> {
  return db.query.media.findFirst({
    where: and(eq(media.id, id), eq(media.workspace_id, workspaceId)),
  });
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
  if (existing) return existing;

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
