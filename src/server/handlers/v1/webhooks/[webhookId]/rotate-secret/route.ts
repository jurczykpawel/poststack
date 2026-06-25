import { authenticateWithScope } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { rotateSecret } from "@/lib/webhooks/endpoints";
import { serializeEndpointWithSecret } from "../../serialize";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ webhookId: string }> };

// POST /api/v1/webhooks/:webhookId/rotate-secret — mint a new signing secret (the previous one stays
// valid during a grace window). Returns the new secret ONCE.
export async function POST(request: Request, ctx: Ctx) {
  const auth = await authenticateWithScope(request, "webhooks:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;

  const { webhookId } = await ctx.params;
  const ep = await rotateSecret(auth.workspaceId, webhookId); // throws ApiError(404) if missing
  return ok(serializeEndpointWithSecret(ep));
}
