import { assertAllowedHost } from "./follow";
import { classifyHttp } from "./http";
import { PermanentError, TransientError } from "./errors";
import { sourceRange, UPLOAD_CHUNK } from "./range-source";
import { asString } from "./util";

export async function uploadYouTube(location: string, source: string, size: number, token: string, resume: boolean, checkpoint?: () => Promise<void> | undefined): Promise<string> {
  assertAllowedHost(location, ["googleapis.com", "googleusercontent.com"]);
  let offset = 0, status = resume, failures = 0;
  while (failures < 4) {
    const first = offset, last = Math.min(size, offset + UPLOAD_CHUNK) - 1;
    const body = status ? undefined : await sourceRange(source, first, last, size);
    let res: Response;
    try {
      res = await fetch(location, {
        method: "PUT", redirect: "manual", signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(body?.length ?? 0), "content-range": status ? `bytes */${size}` : `bytes ${first}-${last}/${size}` }, body,
      });
    } catch { status = true; failures++; continue; }
    if (res.status >= 500) { await res.body?.cancel(); status = true; failures++; continue; }
    if (res.status === 308) {
      const range = res.headers.get("range");
      const match = range ? /^bytes=0-(\d+)$/.exec(range) : undefined;
      const next = range ? Number(match?.[1]) + 1 : 0;
      await res.body?.cancel();
      if (!Number.isSafeInteger(next) || next < offset || next >= size || (!status && next > last + 1)) throw new PermanentError("youtube: invalid upload progress");
      failures = next > offset ? 0 : failures + 1;
      offset = next; status = false;
      await checkpoint?.();
      continue;
    }
    const json = await res.json().catch(() => ({})) as { id?: unknown; error?: { message?: string } };
    const id = asString(json.id);
    if (res.ok && id) return id;
    if (res.ok) throw new TransientError("youtube: upload result unavailable");
    throw classifyHttp(res.status, json.error?.message);
  }
  throw new TransientError("youtube: upload interrupted; resume the saved session");
}
