import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { created, ok, ApiErrors, ApiError, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { getMedia, registerKnownMedia } from "@/lib/media/service";
import { getStorage } from "@/lib/storage";
import { enqueueIngest } from "@/lib/media/async-ingest";
import { setTimeout as delay } from "node:timers/promises";
import { LIMITS } from "@/lib/api/limits";

export const runtime = "nodejs";

const registerBody = z
  .object({
    url: z.string().url().max(LIMITS.url),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    mime: z.string().max(128).optional(),
    kind: z.enum(["video", "image"]).optional(),
    size: z.number().int().positive().optional(),
    durationSec: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  // The reference fast-path keys an object by `casKey(sha256, mime)` (mime → file ext) and resolves
  // `kind` for the row. Without mime the key degrades to `…bin` (never matches a real `…mp4`) and we'd
  // silently re-fetch — so when `sha256` is supplied, both kind AND mime are mandatory.
  .superRefine((v, ctx) => {
    if (v.sha256 && (!v.kind || !v.mime)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sha256 requires kind and mime", path: ["sha256"] });
    }
  });

/** Stored references return immediately; remote sources use a durable worker job. */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateWithScope(request, "media:write");
  if (!auth) return ApiErrors.unauthorized();
  const body = await request.json().catch(() => ({}));
  const parsed = registerBody.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const { url, sha256, mime, kind, size, durationSec, width, height } = parsed.data;
  const storage = getStorage();

  // `sha256 && kind && mime` is always true once sha256 is present (superRefine guarantees it); the
  // explicit conjunction also narrows kind/mime to non-undefined for TS.
  if (sha256 && kind && mime) {
    try {
      const row = await registerKnownMedia({ checksum: sha256, mime, kind, size, durationSec, width, height }, { storage }, auth.workspaceId);
      return created(camelizeKeys(row));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "not_present")) throw e;
      // object not in our bucket → fall through to fetch+store
    }
  }

  let row = await enqueueIngest(url, auth.workspaceId);
  if (new URL(request.url).searchParams.get("wait") === "true") {
    const deadline = Date.now() + 60_000;
    while (row.status === "ingesting" && Date.now() < deadline && !request.signal.aborted) {
      await delay(250);
      const current = await getMedia(row.id, auth.workspaceId);
      if (!current) return ApiErrors.notFound("Media");
      row = current;
    }
    if (row.status === "ready") return created(camelizeKeys(row));
    if (row.status === "failed") throw new ApiError("ingest_failed", row.error ?? "Media ingest failed", 400);
  }
  return ok({ id: row.id, status: row.status, error: row.error }, undefined, 202);
}

export async function GET(request: Request, id: string): Promise<Response> {
  const auth = await authenticateWithScope(request, "media:write");
  if (!auth) return ApiErrors.unauthorized();
  if (!z.string().uuid().safeParse(id).success) return ApiErrors.validationError([{ path: "id", message: "Invalid media id" }]);
  const row = await getMedia(id, auth.workspaceId);
  if (!row) return ApiErrors.notFound("Media");
  return ok(row.status === "ready" ? camelizeKeys(row) : { id: row.id, status: row.status, error: row.error });
}
