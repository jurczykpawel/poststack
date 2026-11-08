import { ApiErrors, ok } from "@/lib/api/response";
import { readAccountReport, type AccountDays } from "@/lib/insights/service";
import { authorizeInsights, statusMeta, type InsightParams } from "../route";

export const runtime = "nodejs";

const PARAMETERS = new Set(["from", "to", "metrics"]);

function parseDays(url: URL): AccountDays | string {
  if (url.search.length > 2049) return "Query string exceeds 2048 characters";
  for (const name of new Set(url.searchParams.keys())) {
    if (!PARAMETERS.has(name)) return `Unknown query parameter: ${name.slice(0, 64)}`;
    if (url.searchParams.getAll(name).length > 1) return `Repeated query parameter: ${name}`;
  }
  const from = url.searchParams.get("from"), to = url.searchParams.get("to"), metrics = url.searchParams.get("metrics");
  if (from === null || to === null) return "from and to are required (YYYY-MM-DD)";
  return { from, to, ...(metrics === null ? {} : { metrics: metrics.split(",") }) };
}

// GET /api/v1/channels/:channelId/insights/account — stored account metrics for provider days [from,to)
export async function GET(request: Request, params: InsightParams): Promise<Response> {
  const ref = await authorizeInsights(request, params, "stats:read");
  if (ref instanceof Response) return ref;
  const days = parseDays(new URL(request.url));
  if (typeof days === "string") return ApiErrors.badRequest(days);
  const report = await readAccountReport(ref, days);
  const latest = [...report.series].sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
  return ok(report, {
    ...statusMeta(report.status),
    apiVersion: latest?.apiVersion ?? null,
    coverage: { from: days.from, toExclusive: days.to, complete: report.coverage.complete, boundaryBasis: report.coverage.boundaryBasis },
  });
}
