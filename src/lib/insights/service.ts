import { providerDayStart } from "./calendar";
import type { Platform } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { requireFeature } from "@/lib/license/gate";
import { getInsightsConnector } from "./catalog";
import { isDecimal } from "./metric-catalog";
import * as repository from "./repository";
import type { ChannelRef, CollectionMode, Decimal, DecimalSigned, InsightAccess, InsightBatch, InsightMetric, InsightObservation, InsightQuery, InsightsConnector, DisplayStatus } from "./types";

type InsightReason = "none" | "first_sync" | "provider_unavailable" | "rate_limited" | "token_required" | "permission_required" | "channel_paused" | "collection_off" | "worker_delayed";
export type InsightStatus = InsightAccess & {
  channelId: string; platform: Platform; source: string; collectionMode: CollectionMode; displayStatus: DisplayStatus;
  lastAttemptAt: string | null; lastSuccessfulSyncAt: string | null; nextRetryAt: string | null;
  reason: InsightReason; stale: boolean;
};
type ReportMetric = InsightMetric & { active: boolean; reason: string | null };
/** `partial`: the start was estimated from the provider's end time and no stored point confirms it. */
type ReportObservation = InsightObservation & { stale: boolean; provisional: boolean; partial: boolean };
export type AccountReport = {
  catalog: ReportMetric[]; series: ReportObservation[];
  summary: { metricKey: string; aggregation: InsightMetric["aggregation"]; value: Decimal | null; complete: boolean; comparisonPercent: DecimalSigned | null; reason: string | null }[];
  coverage: { from: string; toExclusive: string; complete: boolean; boundaryBasis: string | null };
  status: InsightStatus;
};

function publicStatus(ref: ChannelRef, context: Awaited<ReturnType<typeof repository.loadInsightContext>>): InsightStatus {
  const { channel, connection: c } = context;
  const mode = c?.collection_mode ?? "off";
  const state = c?.access_state ?? "unknown";
  const displayStatus: DisplayStatus = mode === "off" ? "off" : state === "unknown" ? "checking" : state === "ready" ? "connected" : "additional_access_required";
  const last = c?.last_success_at;
  const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
  const stale = !!last && Date.now() - last.getTime() > 48 * 3600000;
  let reason: InsightReason = c?.reason ?? (mode === "off" ? "collection_off" : "first_sync");
  if (mode === "off") reason = "collection_off";
  else if (channel.status !== "active") reason = "channel_paused";
  else if (state === "needs_reauth") reason = "token_required";
  else if (state === "missing_permission") reason = "permission_required";
  else if (reason === "none" && !last) reason = "first_sync";
  else if (reason === "none" && stale) reason = "worker_delayed";
  const connector = getInsightsConnector(channel.platform);
  const requiredPermissions = c?.transport ? [...(connector?.requiredPermissions?.(c.transport) ?? [])] : [];
  const grants = c?.transport === "instagram_business" ? c?.ig_grants : c?.fb_grants;
  const proven = !!grants?.revision && grants.revision === c?.credential_revision;
  const missingPermissions = state === "missing_permission" && proven ? requiredPermissions.filter(p=>!grants.names.includes(p)) : [];
  return { channelId: ref.channelId, platform: channel.platform, source: connector?.source ?? (channel.platform === "instagram" ? "meta_instagram" : channel.platform),
    collectionMode: mode, displayStatus, state, transport: c?.transport ?? null, credentialRevision: c?.credential_revision ?? null,
    requiredPermissions, missingPermissions, checkedAt: iso(c?.access_checked_at), lastAttemptAt: iso(c?.last_attempt_at),
    lastSuccessfulSyncAt: iso(last), nextRetryAt: iso(c?.backoff_until), reason, stale };
}

const unsupported = () => new ApiError("insights_unsupported", "Insights are not available for this channel", 422);
const invalidRange = (message: string) => new ApiError("bad_request", message, 400);

/** Request boundary order: workspace channel, platform capability, then license. */
export async function requireInsightChannel(ref: ChannelRef): Promise<{ platform: Platform; subjectKey: string; connector: InsightsConnector }> {
  const channel = await repository.findInsightChannel(ref);
  if (!channel) throw new ApiError("not_found", "Channel not found", 404);
  const connector = getInsightsConnector(channel.platform);
  if (!connector) throw unsupported();
  await requireFeature("insights");
  return { platform: channel.platform, subjectKey: channel.platform_id, connector };
}

export async function getInsightStatus(ref: ChannelRef): Promise<InsightStatus> {
  await requireFeature("insights");
  return publicStatus(ref, await repository.loadInsightContext(ref));
}

export async function setCollectionMode(ref: ChannelRef, mode: CollectionMode): Promise<InsightStatus> {
  await requireFeature("insights");
  if (mode !== "on" && mode !== "off") throw new ApiError("invalid_request", "Invalid collection mode", 422);
  const context = await repository.loadInsightContext(ref);
  if (mode === "on" && !getInsightsConnector(context.channel.platform)) throw unsupported();
  await repository.changeCollectionMode(ref, mode);
  return getInsightStatus(ref);
}

function validateQuery(query: InsightQuery, catalog: readonly InsightMetric[]) {
  const from = Date.parse(query.from), to = Date.parse(query.to);
  // One extra hour admits 90 provider days that include a daylight-saving change.
  if (query.level !== "account" || !query.subjectKey || query.subjectKey.length > 255 ||
    !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 90 * 86400000 + 3600000 ||
    !["day", "range", "snapshot"].includes(query.grain) || !query.metrics.length || query.metrics.length > 64 ||
    new Set(query.metrics).size !== query.metrics.length || query.metrics.some(key => !catalog.some(m => m.key === key && m.level === "account"))) throw invalidRange("Invalid account insights query");
}

export async function readAccountInsights(ref: ChannelRef, query: InsightQuery): Promise<AccountReport> {
  await requireFeature("insights");
  const context = await repository.loadInsightContext(ref);
  const catalog = getInsightsConnector(context.channel.platform)?.catalog() ?? [];
  validateQuery(query, catalog);
  if (query.subjectKey !== context.channel.platform_id) throw invalidRange("Invalid insights subject");
  const rows = await repository.readObservations(ref, query);
  return buildAccountReport(catalog, rows, query, publicStatus(ref, context));
}

/** Milliseconds of a YYYY-MM-DD calendar date at UTC midnight, or null for anything else. */
function calendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export type AccountDays = { from: string; to: string; metrics?: readonly string[] };

/** Account report for provider calendar days [from,to); defaults to every account metric in the catalog. */
export async function readAccountReport(ref: ChannelRef, days: AccountDays): Promise<AccountReport> {
  const { connector, subjectKey } = await requireInsightChannel(ref);
  const from = calendarDay(days.from), to = calendarDay(days.to);
  if (from === null || to === null) throw invalidRange("from and to must be calendar dates (YYYY-MM-DD)");
  if (to <= from || to - from > 90 * 86400000) throw invalidRange("The range must cover 1 to 90 days; to is exclusive");
  const catalog = connector.catalog().filter(m => m.level === "account");
  const metrics = days.metrics ?? catalog.map(m => m.key);
  if (!metrics.length || metrics.length > 16 || new Set(metrics).size !== metrics.length || metrics.some(key => key.length > 128 || !catalog.some(m => m.key === key))) {
    throw invalidRange("metrics must list up to 16 distinct account metrics from the channel catalog");
  }
  return readAccountInsights(ref, { level: "account", subjectKey, grain: "day", metrics,
    from: providerDayStart(days.from, connector.dayTimeZone), to: providerDayStart(days.to, connector.dayTimeZone) });
}

function validateMap(map: Record<string, string>) {
  const entries = Object.entries(map);
  if (Buffer.byteLength(JSON.stringify(map)) > 8192 || entries.length > 32 || entries.some(([k, v]) => !k || k.length > 128 || typeof v !== "string" || v.length > 128 || /token|secret|authorization/i.test(k))) throw new Error("Invalid insights parameters");
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value.slice(0,19) + "Z").toISOString().slice(0,19) === value.slice(0,19);
}

/** Worker batches carry their current claim; unclaimed writes retain the three-argument form. */
export async function storeInsightBatch(ref: ChannelRef, revision: string, batch: InsightBatch, claimToken?: string, progress?: repository.InsightProgress): Promise<number> {
  await requireFeature("insights");
  const { channel } = await repository.loadInsightContext(ref);
  const catalog = getInsightsConnector(channel.platform)?.catalog() ?? [];
  if (!revision || revision.length > 128 || batch.observations.length > 1000 || (claimToken !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimToken))) throw new Error("Invalid insights batch");
  for (const o of batch.observations) {
    const metric = catalog.find(m => m.key === o.metricKey);
    if (!metric || metric.definitionVersion !== o.definitionVersion || metric.level !== o.level || metric.period !== o.period || o.platform !== channel.platform || o.subjectKey !== channel.platform_id ||
      !["day","range","snapshot","audience_window"].includes(o.grain) || !["time_series","total_value","profile_field","media_lifetime"].includes(o.metricType) ||
      !["available","not_available","insufficient_audience","unsupported"].includes(o.state) ||
      ![o.fetchedAt,o.windowStart,o.windowEnd].every(validTimestamp) || Date.parse(o.windowEnd) <= Date.parse(o.windowStart) ||
      (o.state === "available" && o.grain === "day" && (!o.providerDay || o.providerDay !== o.snapshotDay || Date.parse(o.windowEnd)-Date.parse(o.windowStart) < 23*3600000 || Date.parse(o.windowEnd)-Date.parse(o.windowStart) > 25*3600000)) ||
      ![o.snapshotDay, ...(o.providerDay ? [o.providerDay] : [])].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d) ||
      (o.state === "available" ? !isDecimal(o.value) || o.value.length > 512 : o.value !== null) ||
      ![o.transport,o.apiVersion,o.definitionVersion,o.boundaryBasis,o.coverageBasis].every(s=>typeof s === "string" && s.length > 0 && s.length <= 128)) throw new Error("Invalid insights observation");
    validateMap(o.dimensions); validateMap(o.queryParams);
  }
  return repository.upsertInsightBatch(ref, revision, batch, claimToken, progress);
}

/** Integer arithmetic keeps stored decimal strings exact; comparisons round to six decimal places. */
function scaled(values: string[]) {
  const scale = Math.max(0, ...values.map(value => value.split(".")[1]?.length ?? 0));
  return { scale, values: values.map(value => { const [whole, fraction = ""] = value.split("."); return BigInt(whole + fraction.padEnd(scale,"0")); }) };
}
function decimal(value: bigint, scale: number): string {
  const negative = value < BigInt(0);
  let digits = (negative ? -value : value).toString().padStart(scale + 1,"0");
  if (scale) digits = `${digits.slice(0,-scale)}.${digits.slice(-scale)}`.replace(/0+$/,"").replace(/\.$/,"");
  return `${negative && value !== BigInt(0) ? "-" : ""}${digits}`;
}
function sum(values: string[]) { const aligned = scaled(values); return decimal(aligned.values.reduce((a,b)=>a+b,BigInt(0)),aligned.scale); }
function comparison(current: string, previous: string): string | null {
  const { values: [a,b] } = scaled([current,previous]);
  if (b === BigInt(0)) return null;
  const numerator = (a-b)*BigInt(100)*BigInt(1000000);
  const magnitude = numerator < BigInt(0) ? -numerator : numerator;
  const rounded = (magnitude + b/BigInt(2))/b;
  return decimal(numerator < BigInt(0) ? -rounded : rounded,6);
}
/** Series identity; boundaryBasis is per-point certainty, so it never splits a series. */
function semantics(o: InsightObservation): string {
  const params = Object.entries(o.queryParams).filter(([key])=>!["since","until","from","to","metric","metric_type","period"].includes(key)).sort(([a],[b])=>a === b ? 0 : a < b ? -1 : 1);
  return JSON.stringify([o.transport,o.apiVersion,o.definitionVersion,o.coverageBasis,o.metricType,o.period,o.grain,Object.entries(o.dimensions).sort(([a],[b])=>a === b ? 0 : a < b ? -1 : 1),params]);
}
function instant(value: string) { return Date.parse(value); }
const estimated = (o: InsightObservation) => /unconfirmed/.test(o.boundaryBasis);
function latest(rows: InsightObservation[]) {
  return [...rows].sort((a,b)=>instant(b.fetchedAt)-instant(a.fetchedAt) || semantics(a).localeCompare(semantics(b)))[0];
}
function aggregate(metric: InsightMetric, rows: InsightObservation[], from: number, to: number): { value: string | null; complete: boolean; basis: string | null } {
  const relevant = rows.filter(o=>instant(o.windowStart)>=from && instant(o.windowEnd)<=to && o.state === "available" && o.value !== null && !estimated(o) && Object.keys(o.dimensions).length === 0);
  if (metric.aggregation === "unique_range") {
    const exact = latest(relevant.filter(o=>o.grain === "range" && instant(o.windowStart)===from && instant(o.windowEnd)===to));
    return {value:exact?.value ?? null,complete:!!exact,basis:exact?.boundaryBasis ?? null};
  }
  if (metric.aggregation === "latest_snapshot") {
    const snapshot = latest(relevant.filter(o=>o.grain === "snapshot"));
    return {value:snapshot?.value ?? null,complete:!!snapshot,basis:snapshot?.boundaryBasis ?? null};
  }
  const days = relevant.filter(o=>o.grain === "day").sort((a,b)=>instant(a.windowStart)-instant(b.windowStart));
  let cursor = from;
  for (const day of days) {
    if (instant(day.windowStart)!==cursor || instant(day.windowEnd)-cursor < 23*3600000 || instant(day.windowEnd)-cursor > 25*3600000) return {value:null,complete:false,basis:null};
    cursor = instant(day.windowEnd);
  }
  if (!days.length || cursor!==to) return {value:null,complete:false,basis:null};
  return {value:sum(days.map(o=>o.value!)),complete:true,basis:days[0].boundaryBasis};
}

const inactiveInstagram = [
  { key:"views",label:"Views",reason:"no_account_response_evidence",aggregation:"sum",additive:true,cardOrder:1 },
  { key:"total_interactions",label:"Interactions",reason:"no_account_response_evidence",aggregation:"sum",additive:true,cardOrder:3 },
  { key:"accounts_engaged",label:"Accounts engaged",reason:"no_account_response_evidence",aggregation:"unique_range",additive:false,cardOrder:null },
  { key:"followers",label:"Followers",reason:"no_profile_field_evidence",aggregation:"latest_snapshot",additive:false,cardOrder:4 },
] as const;

/** Pure report projection shared by REST and SSR consumers. */
export function buildAccountReport(catalog: readonly InsightMetric[], observations: InsightObservation[], query: InsightQuery, status: InsightStatus): AccountReport {
  const from=instant(query.from), to=instant(query.to), previousFrom=from-(to-from), now=Date.now();
  const entries: ReportMetric[] = catalog.filter(m=>m.level === "account" && query.metrics.includes(m.key)).map(m=>({...m,active:true,reason:null}));
  if (status.platform === "instagram") for (const m of inactiveInstagram) if (!catalog.some(active=>active.key === m.key)) entries.push({
    key:m.key,label:m.label,level:"account",unit:"count",period:m.key === "followers" ? "lifetime" : "day",grain:m.key === "followers" ? "snapshot" : "day",
    aggregation:m.aggregation,additive:m.additive,definitionVersion:"unavailable",coverageBasis:"unavailable",cardOrder:m.cardOrder,chartable:false,active:false,reason:m.reason,
  });
  const series: ReportObservation[] = [];
  const bases = new Set<string>();
  const summary = entries.map(metric=>{
    let rows = observations.filter(o=>o.metricKey===metric.key && o.level===query.level && o.subjectKey===query.subjectKey && o.definitionVersion===metric.definitionVersion);
    // Select one definition/transport series; corrections replace a stored interval. A provider day is
    // identified by its end time (the start of a first-of-response point is only estimated), so the
    // newest value wins and a confirmed start from any stored point replaces the estimate.
    const corrected = new Map<string,{latest:InsightObservation;confirmed?:InsightObservation}>();
    for (const o of rows) {
      const key=JSON.stringify([o.grain,o.grain === "day" ? null : instant(o.windowStart),instant(o.windowEnd),semantics(o)]);
      const entry=corrected.get(key) ?? {latest:o};
      if (o.state === "available" && (entry.latest.state !== "available" || instant(o.fetchedAt)>instant(entry.latest.fetchedAt))) entry.latest=o;
      if (!estimated(o) && (!entry.confirmed || instant(o.fetchedAt)>instant(entry.confirmed.fetchedAt))) entry.confirmed=o;
      corrected.set(key,entry);
    }
    rows=[...corrected.values()].map(({latest:o,confirmed:c})=>!c || !estimated(o) ? o :
      {...o,windowStart:c.windowStart,providerDay:c.providerDay,snapshotDay:c.snapshotDay,boundaryBasis:c.boundaryBasis});
    const cohort = (grain: InsightObservation["grain"]) => {
      const candidates=rows.filter(o=>o.grain === grain);
      const anchor=latest(candidates.filter(o=>o.state === "available" && instant(o.windowStart)>=from && instant(o.windowEnd)<=to));
      return anchor ? candidates.filter(o=>semantics(o)===semantics(anchor)) : [];
    };
    const seriesRows=cohort(query.grain);
    const aggregateRows=cohort(metric.aggregation === "unique_range" ? "range" : metric.aggregation === "latest_snapshot" ? "snapshot" : "day");
    for (const o of seriesRows.filter(o=>instant(o.windowStart)>=from && instant(o.windowEnd)<=to)) series.push({...o,stale:now-instant(o.fetchedAt)>48*3600000,provisional:instant(o.windowEnd)>now-48*3600000,partial:estimated(o)});
    const current=metric.active ? aggregate(metric,aggregateRows,from,to) : {value:null,complete:false,basis:null};
    const previous=aggregate(metric,aggregateRows,previousFrom,from);
    if (current.basis) bases.add(current.basis);
    return {metricKey:metric.key,aggregation:metric.aggregation,value:current.value,complete:current.complete,
      comparisonPercent:current.complete && previous.complete && current.value!==null && previous.value!==null ? comparison(current.value,previous.value) : null,
      reason:metric.reason ?? (current.complete ? null : metric.aggregation === "unique_range" ? "unique_range_unavailable" : "incomplete_coverage")};
  });
  const activeSummary=summary.filter(s=>entries.find(e=>e.key===s.metricKey)?.active);
  return {catalog:entries,series:series.sort((a,b)=>instant(a.windowStart)-instant(b.windowStart)||a.metricKey.localeCompare(b.metricKey)),summary,
    coverage:{from:query.from,toExclusive:query.to,complete:activeSummary.length>0 && activeSummary.every(s=>s.complete) && bases.size===1,boundaryBasis:bases.size===1 ? [...bases][0] : null},status};
}
