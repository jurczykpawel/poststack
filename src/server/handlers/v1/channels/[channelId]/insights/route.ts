import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import type { ApiScope } from "@/lib/auth/scopes";
import { ApiErrors, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/body-limit";
import { getInsightStatus, requireInsightChannel, setCollectionMode, type InsightStatus } from "@/lib/insights/service";
import { enqueueInsights } from "@/lib/insights/schedule";
import type { ChannelRef } from "@/lib/insights/types";
import { isSameOriginRequest } from "@/server/middleware/same-origin";

export const runtime = "nodejs";

export type InsightParams = { params: Promise<{ channelId: string }> };

/**
 * Shared boundary for every insights route: authentication and scope, same-origin for dashboard
 * writes, then workspace channel → capability → license. Returns a ready response on refusal.
 */
export async function authorizeInsights(request: Request, { params }: InsightParams, scope: ApiScope): Promise<ChannelRef | Response> {
  const auth = await authenticateWithScope(request, scope);
  if (!auth) return ApiErrors.unauthorized();
  if (auth.authMethod === "session" && !isSameOriginRequest(request.method, request.headers)) return ApiErrors.forbidden();
  const ref = { workspaceId: auth.workspaceId, channelId: (await params).channelId };
  await requireInsightChannel(ref);
  return ref;
}

/** Provenance and sync timing shared by status and report responses. */
export function statusMeta(status: InsightStatus) {
  return { source: status.source, transport: status.transport, lastSuccessfulSyncAt: status.lastSuccessfulSyncAt, nextRetryAt: status.nextRetryAt };
}

const CONSENT_HINT = "Access is checked in the background. If additional access is required, reconnect the channel from the dashboard Channels page.";
const patchSchema = z.object({ collectionMode: z.enum(["on", "off"]) }).strict();

// GET /api/v1/channels/:channelId/insights — locally stored collection status
export async function GET(request: Request, params: InsightParams): Promise<Response> {
  const ref = await authorizeInsights(request, params, "stats:read");
  if (ref instanceof Response) return ref;
  const status = await getInsightStatus(ref);
  return ok(status, statusMeta(status));
}

// PATCH /api/v1/channels/:channelId/insights — switch collection on (queues an access check) or off
export async function PATCH(request: Request, params: InsightParams): Promise<Response> {
  const ref = await authorizeInsights(request, params, "channels:write");
  if (ref instanceof Response) return ref;
  const parsed = patchSchema.safeParse(await parseJsonBody(request, 1_024));
  if (!parsed.success) return ApiErrors.validationError(parsed.error);
  const status = await setCollectionMode(ref, parsed.data.collectionMode);
  if (parsed.data.collectionMode === "off") return ok(status, statusMeta(status));
  await enqueueInsights(ref, "enable");
  return ok(status, { ...statusMeta(status), hint: CONSENT_HINT });
}
