import { getMedia } from "@/lib/media/service";
import { PermanentError } from "@/lib/providers/errors";
import type { MediaRef } from "@/lib/providers/types";

export class MediaIngestingError extends Error {}

/** Resolve media refs to public URLs, scoped to the workspace (a ref to another tenant's media
 *  resolves to "not found"). */
export async function resolveMedia(media: MediaRef[], workspaceId: string): Promise<string[]> {
  return (await resolveMediaDetails(media, workspaceId)).map(row => row.url);
}

export async function resolveMediaDetails(media: MediaRef[], workspaceId: string) {
  const rows: { url: string; durationSec: number | null; width: number | null; height: number | null }[] = [];
  for (const m of media) {
    const row = await getMedia(m.mediaId, workspaceId).catch(() => undefined);
    if (!row) throw new PermanentError(`referenced media not found: ${m.mediaId}`);
    if (row.status === "ingesting") throw new MediaIngestingError(`referenced media is ingesting: ${m.mediaId}`);
    if (row.status !== "ready") throw new PermanentError(`referenced media is ${row.status}: ${m.mediaId}${row.error ? `: ${row.error}` : ""}`);
    rows.push({ url: row.url, durationSec: row.duration_sec, width: row.width, height: row.height });
  }
  return rows;
}
