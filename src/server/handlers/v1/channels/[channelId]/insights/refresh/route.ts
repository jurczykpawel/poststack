import { err, ok } from "@/lib/api/response";
import { getInsightStatus } from "@/lib/insights/service";
import { enqueueInsights } from "@/lib/insights/schedule";
import { authorizeInsights, type InsightParams } from "../route";

export const runtime = "nodejs";

// POST /api/v1/channels/:channelId/insights/refresh — queue a collection run; never sends or publishes
export async function POST(request: Request, params: InsightParams): Promise<Response> {
  const ref = await authorizeInsights(request, params, "channels:write");
  if (ref instanceof Response) return ref;
  const { queued, nextRetryAt } = await enqueueInsights(ref, "refresh");
  if (!queued && nextRetryAt) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(nextRetryAt) - Date.now()) / 1000));
    const response = err("rate_limited", "Insights refresh is not available yet", 429, { retry_after: retryAfter, next_retry_at: nextRetryAt });
    response.headers.set("Retry-After", String(retryAfter));
    return response;
  }
  return ok({ status: await getInsightStatus(ref), queued }, undefined, 202);
}
