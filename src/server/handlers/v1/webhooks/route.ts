import { authenticateWithScope } from "@/lib/auth";
import { ok, created, ApiErrors, zodDetails } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { createEndpoint, listEndpoints } from "@/lib/webhooks/endpoints";
import { serializeEndpoint, serializeEndpointWithSecret } from "./serialize";
import { z } from "zod";

export const runtime = "nodejs";

const createSchema = z.object({
  url: z.string().min(1).max(2000),
  // Subscribe to specific event types, or omit/empty for ALL. Names are validated against the
  // catalog in the service (a 422 with the offending types), so the schema only bounds shape/size.
  event_types: z.array(z.string().min(1).max(100)).max(50).optional(),
});

// GET /api/v1/webhooks — list this workspace's webhook endpoints (without signing secrets).
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "webhooks:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;

  const rows = await listEndpoints(auth.workspaceId);
  return ok(rows.map(serializeEndpoint));
}

// POST /api/v1/webhooks — register an endpoint. Returns the signing secret ONCE.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "webhooks:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("outbound_webhooks");
  if (gate) return gate;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));

  // createEndpoint throws ApiError(422) for a bad url / unknown event type — mapped by app.onError.
  const ep = await createEndpoint(auth.workspaceId, { url: parsed.data.url, eventTypes: parsed.data.event_types });
  return created(serializeEndpointWithSecret(ep));
}
