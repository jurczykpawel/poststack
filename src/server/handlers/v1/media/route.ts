import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { created, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { registerByUrl } from "@/lib/media/service";
import { getStorage } from "@/lib/storage";
import { defaultProbe } from "@/lib/media/probe";
import { LIMITS } from "@/lib/api/limits";

export const runtime = "nodejs";

const registerBody = z.object({ url: z.string().url().max(LIMITS.url) });

/** Register a media URL into content-addressed storage (SSRF-guarded, workspace-scoped). */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const body = await request.json().catch(() => ({}));
  const parsed = registerBody.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await registerByUrl(parsed.data.url, { storage: getStorage(), probe: defaultProbe }, auth.workspaceId);
  return created(camelizeKeys(row));
}
