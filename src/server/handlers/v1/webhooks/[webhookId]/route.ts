import { authenticateWithScope } from "@/lib/auth";
import { ok, noContent, ApiErrors, zodDetails } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { getEndpoint, updateEndpoint, deleteEndpoint } from "@/lib/webhooks/endpoints";
import { serializeEndpoint } from "../serialize";
import { z } from "zod";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ webhookId: string }> };

const patchSchema = z.object({
  url: z.string().min(1).max(2000).optional(),
  event_types: z.array(z.string().min(1).max(100)).max(50).optional(),
  active: z.boolean().optional(),
});

// GET /api/v1/webhooks/:webhookId
export async function GET(request: Request, ctx: Ctx) {
  const auth = await authenticateWithScope(request, "webhooks:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;

  const { webhookId } = await ctx.params;
  const ep = await getEndpoint(auth.workspaceId, webhookId);
  if (!ep) return ApiErrors.notFound("Webhook endpoint");
  return ok(serializeEndpoint(ep));
}

// PATCH /api/v1/webhooks/:webhookId — update url / event types / active.
export async function PATCH(request: Request, ctx: Ctx) {
  const auth = await authenticateWithScope(request, "webhooks:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;

  const { webhookId } = await ctx.params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));

  // updateEndpoint throws ApiError(404) for an unknown/cross-tenant id, 422 for a bad url/type.
  const ep = await updateEndpoint(auth.workspaceId, webhookId, {
    url: parsed.data.url,
    eventTypes: parsed.data.event_types,
    active: parsed.data.active,
  });
  return ok(serializeEndpoint(ep));
}

// DELETE /api/v1/webhooks/:webhookId — remove the endpoint and its deliveries.
export async function DELETE(request: Request, ctx: Ctx) {
  const auth = await authenticateWithScope(request, "webhooks:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;

  const { webhookId } = await ctx.params;
  await deleteEndpoint(auth.workspaceId, webhookId); // throws ApiError(404) if missing
  return noContent();
}
