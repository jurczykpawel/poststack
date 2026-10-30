import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { ok, ApiErrors, zodDetails } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { listWebhookDeliveries } from "@/lib/webhooks/deliveries";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1000).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ webhookId: string }> }) {
  const auth = await authenticateWithScope(request, "webhooks:read");
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const { webhookId } = await context.params;
  const { items, meta } = await listWebhookDeliveries(auth.workspaceId, webhookId, parsed.data.limit, parsed.data.cursor);
  return ok(items, meta);
}
