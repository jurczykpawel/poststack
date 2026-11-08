import { and, asc, eq, isNull } from "drizzle-orm";
import { channels, platform as platformEnum, type Platform } from "@/db/schema";
import { db } from "@/lib/db";
import { getInsightsConnector } from "@/lib/insights/catalog";
import { readAccountReport, type AccountReport } from "@/lib/insights/service";
import type { ChannelRef } from "@/lib/insights/types";
import { hasFeature } from "@/lib/license/gate";
import { PLATFORM_LABELS } from "../components/platform";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
export const INSIGHT_RANGES = [7, 30] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];

export type InsightChannelOption = { id: string; platform: Platform; label: string; brandKey: string | null };
/** Normalized URL state of the screen: everything the page needs is in the query string. */
export type InsightsQuery = { brand: string; channel: string; range: InsightRange; metric: string };

export function readInsightsQuery(params: URLSearchParams): InsightsQuery {
  const clip = (name: string, max: number) => (params.get(name) ?? "").trim().slice(0, max);
  const channel = clip("channel", 36);
  return {
    brand: clip("brand", 64),
    channel: UUID_RE.test(channel) ? channel : channel ? "invalid" : "",
    range: params.get("range") === "30" ? 30 : 7,
    metric: clip("metric", 128),
  };
}

/** Query string for the screen; empty values are left out so URLs stay short. */
export function insightsHref(q: Partial<InsightsQuery>, path = "/insights"): string {
  const params = new URLSearchParams();
  for (const key of ["brand", "channel", "range", "metric"] as const) {
    const value = q[key];
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** Labels of every platform with an insights connector, for the "connect a channel" state. */
export function insightPlatforms(): string[] {
  return platformEnum.enumValues.filter((p) => getInsightsConnector(p)).map((p) => PLATFORM_LABELS[p] ?? p);
}

/** Today's calendar date in the provider's day zone. */
function providerToday(timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Workspace channels whose platform has the insights capability, regardless of current access. */
async function insightChannels(workspaceId: string): Promise<InsightChannelOption[]> {
  const rows = await db.select({ id: channels.id, platform: channels.platform, display_name: channels.display_name, username: channels.username, platform_id: channels.platform_id, brand_key: channels.brand_key })
    .from(channels).where(and(eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at))).orderBy(asc(channels.created_at), asc(channels.id));
  return rows.filter((r) => getInsightsConnector(r.platform)).map((r) => ({
    id: r.id, platform: r.platform, brandKey: r.brand_key,
    label: `${PLATFORM_LABELS[r.platform] ?? r.platform} · ${r.display_name ?? r.username ?? r.platform_id}`,
  }));
}

/**
 * Everything the account screen renders. A requested channel outside the (brand-filtered) list is
 * reported as missing (`selected: null`), never silently swapped for the first channel. Reads only
 * the local database; the provider is never contacted while rendering.
 */
export async function loadInsightsPage(workspaceId: string, params: URLSearchParams): Promise<{
  channels: InsightChannelOption[]; selected: ChannelRef | null; report: AccountReport | null; query: InsightsQuery;
}> {
  const query = readInsightsQuery(params);
  const all = await insightChannels(workspaceId);
  const options = query.brand ? all.filter((c) => c.brandKey === query.brand) : all;
  const chosen = query.channel ? options.find((c) => c.id === query.channel) : options[0];
  const selected = chosen ? { workspaceId, channelId: chosen.id } : null;
  if (!chosen || !selected || !(await hasFeature("insights"))) return { channels: options, selected, report: null, query };
  const to = providerToday(getInsightsConnector(chosen.platform)?.dayTimeZone);
  const report = await readAccountReport(selected, { from: shiftDay(to, -query.range), to });
  return { channels: options, selected, report, query };
}
