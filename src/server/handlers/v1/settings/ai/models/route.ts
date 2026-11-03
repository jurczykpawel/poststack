import { z } from "zod";
import { authenticateInstanceScope } from "@/lib/auth/instance-operator";
import { ok, err, ApiErrors } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/body-limit";
import { rateLimit } from "@/lib/api/rate-limit";
import { listAiModels } from "@/lib/ai/settings";
import { candidateSchema } from "../route";

export const runtime = "nodejs";

const schema = candidateSchema.extend({ refresh: z.boolean().default(false), all: z.boolean().default(false) });

// POST /api/v1/settings/ai/models — model list of a provider (saved config, or a candidate before saving)
export async function POST(request: Request) {
  const auth = await authenticateInstanceScope(request, "instance_ai:read");
  if (!auth) return ApiErrors.unauthorized();
  if (!(await rateLimit(`rl:ai-models:${auth.userId}`, 10, 60)).allowed) return ApiErrors.tooManyRequests("Too many model list requests. Try again in a minute.");
  const parsed = schema.safeParse(await parseJsonBody(request, 4_096));
  if (!parsed.success) return ApiErrors.validationError(parsed.error);
  const result = await listAiModels(parsed.data, parsed.data);
  return result.ok ? ok(result.list) : err(result.code, result.message, result.status, result.details);
}
