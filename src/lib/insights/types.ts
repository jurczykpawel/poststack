import type { Platform } from "@/db/schema";

/** Canonical non-negative decimal: no exponent, redundant zeros or JS rounding. */
export type Decimal = string;
/** Canonical decimal with an optional minus, for computed results only; no negative zero. */
export type DecimalSigned = string;
export type InsightLevel = "account" | "post" | "audience";
export type InsightGrain = "day" | "range" | "snapshot" | "audience_window";
export type AccessState = "unknown" | "ready" | "missing_permission" | "needs_reauth" | "unsupported";
export type ResponseState = "available" | "not_available" | "insufficient_audience" | "unsupported";
export type CollectionMode = "off" | "on";
export type DisplayStatus = "off" | "checking" | "additional_access_required" | "connected";
/** A key from the selected platform's validated catalog. Resolve with getMetric before use. */
export type MetricKey = string;
export type ChannelRef = { workspaceId: string; channelId: string };

export type InsightMetric = {
  key: MetricKey;
  label: string;
  level: InsightLevel;
  unit: "count" | "percent" | "milliseconds";
  period: "day" | "lifetime";
  /** Default series grain; range queries can use the same key without a second definition. */
  grain: InsightGrain;
  aggregation: "sum" | "unique_range" | "latest_snapshot";
  additive: boolean;
  definitionVersion: string;
  coverageBasis: string;
  cardOrder: number | null;
  chartable: boolean;
};

/** Provider windows are [from,to); provider-day boundaries stay in the provider's basis. */
export type InsightQuery = {
  level: InsightLevel;
  subjectKey: string;
  from: string;
  to: string;
  metrics: readonly MetricKey[];
  grain: InsightGrain;
};

export type InsightObservation = {
  platform: Platform;
  metricKey: MetricKey;
  level: InsightLevel;
  subjectKey: string;
  grain: InsightGrain;
  period: "day" | "lifetime";
  metricType: "time_series" | "total_value" | "profile_field" | "media_lifetime";
  windowStart: string;
  windowEnd: string;
  snapshotDay: string;
  fetchedAt: string;
  providerDay: string | null;
  boundaryBasis: string;
  /** null is missing data; "0" is an observed numeric zero. */
  value: Decimal | null;
  state: ResponseState;
  dimensions: Record<string, string>;
  queryParams: Record<string, string>;
  transport: string;
  apiVersion: string;
  definitionVersion: string;
  coverageBasis: string;
};

/** In-memory only. Never serialize credentials into observations, DTOs or queued jobs. */
export type InsightCredential = {
  transport: string;
  token: string;
  accountKey: string;
  revision: string;
  budgetKey: string;
};

export type InsightAccess = {
  state: AccessState;
  transport: string | null;
  credentialRevision: string | null;
  requiredPermissions: string[];
  missingPermissions: string[];
  checkedAt: string | null;
};

export type InsightBatch = {
  observations: InsightObservation[];
  usage: { percent: number | null; regainAfterSeconds: number | null };
};

export type InsightFailureKind =
  | "transient" | "rate_limited" | "missing_permission" | "invalid_token" | "unsupported_metric" | "unknown";

/** Bounded transport failure; no raw provider error belongs in a public DTO. */
export type InsightFailure = {
  [Kind in InsightFailureKind]: { kind: Kind; retryAfterSeconds: number | null };
}[InsightFailureKind];

export interface InsightsConnector {
  readonly source?: string;
  requiredPermissions?(transport: string): readonly string[];
  catalog(): readonly InsightMetric[];
  /** Bounded Insights GET; no speculative permissions endpoint. */
  access(credential: InsightCredential): Promise<InsightAccess>;
  fetch(credential: InsightCredential, query: InsightQuery): Promise<InsightBatch>;
  /** Local credential selection only; rendering must not start OAuth or a provider request. */
  consentTransport(ref: ChannelRef): Promise<string | null>;
}
