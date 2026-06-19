import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { ok, ApiErrors } from "@/lib/api/response";
import { getResponseTimeStats, DEFAULT_WINDOW_DAYS } from "@/lib/metrics/response-times";

export const runtime = "nodejs";

// GET /api/v1/stats/response-times — answer-rate, average latency and first-response percentiles for
// the authed workspace over a trailing `window` (days; default 30). The numbers union the live
// metrics with the rolled-up daily stats, so compaction never changes them. (TIMING6)
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "stats:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const url = new URL(request.url);
  const windowRaw = url.searchParams.get("window");
  // getResponseTimeStats clamps the window into [1, 365]; an unparsable value falls back to default.
  const windowDays = windowRaw == null ? DEFAULT_WINDOW_DAYS : Number(windowRaw);

  const stats = await getResponseTimeStats(db, { workspaceId: auth.workspaceId, windowDays });
  return ok(stats, { window_days: stats.window_days });
}
