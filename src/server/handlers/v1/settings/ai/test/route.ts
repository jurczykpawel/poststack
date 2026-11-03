import { authenticateInstanceScope } from "@/lib/auth/instance-operator";
import { ok, err, ApiErrors } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/body-limit";
import { rateLimit } from "@/lib/api/rate-limit";
import { testAiSettings } from "@/lib/ai/settings";
import { candidateSchema } from "../route";

export const runtime = "nodejs";

// POST /api/v1/settings/ai/test — one tiny chat request (costs a few tokens); the result is in `data.ok`
export async function POST(request: Request) {
  const auth = await authenticateInstanceScope(request, "instance_ai:write");
  if (!auth) return ApiErrors.unauthorized();
  if (!(await rateLimit(`rl:ai-test:${auth.userId}`, 5, 60)).allowed) return ApiErrors.tooManyRequests("Too many connection tests. Try again in a minute.");
  const parsed = candidateSchema.safeParse(await parseJsonBody(request, 4_096));
  if (!parsed.success) return ApiErrors.validationError(parsed.error);
  const result = await testAiSettings(parsed.data);
  return result.ok ? ok(result.result) : err(result.code, result.message, result.status, result.details);
}
