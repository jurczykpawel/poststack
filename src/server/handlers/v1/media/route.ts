import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { created, ApiErrors, ApiError, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { registerByUrl, registerKnownMedia } from "@/lib/media/service";
import { getStorage } from "@/lib/storage";
import { defaultProbe } from "@/lib/media/probe";
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

/** Register a media URL into content-addressed storage (SSRF-guarded, workspace-scoped). When an
 *  sha256+kind+mime reference is supplied, try the no-fetch fast-path (link an object ReelStack/another
 *  producer already wrote to the shared CAS bucket); on not_present fall back to fetch+store. */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
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

  const row = await registerByUrl(url, { storage, probe: defaultProbe }, auth.workspaceId);
  return created(camelizeKeys(row));
}
