// TELEMETRY3: collectors + envelope builder. Gathers an anonymous, instance-wide usage report — only
// versions, deployment flags, integration BOOLEANS/labels and aggregate counts. It never reads or
// emits a secret, a token, or any per-person identifier; the only identity it carries is the hashed
// instance/domain/license from ./identity. The envelope is versioned (schema_version) and `metrics`
// is an open object so new counters can be added without a wire-format break.

import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { and, count, eq, gt, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { db as Db } from "@/lib/db";
import {
  channels,
  contacts,
  conversations,
  autoReplyRules,
  sequences,
  outboundDeliveries,
  commentLogs,
  workspaces,
  webhookEvents,
  webhookEventStats,
  type Platform,
} from "@/db/schema";
import { mergeWebhookStatusCounts, mergeWebhookPlatformCounts } from "@/lib/history/stats-read";
import { getInstanceResponseTimeStats, DEFAULT_WINDOW_DAYS } from "@/lib/metrics/response-times";
import { env } from "@/lib/env";
import { ensureInstanceId, domainHash, getLicenseIdentity } from "./identity";
import { TELEMETRY_PROJECT } from "./constants";

type Executor = typeof Db;

const DAY_MS = 86_400_000;

/** Read this package's version once from package.json (project root, three levels up from this file). */
function readAppVersion(): string {
  try {
    const root = new URL("../../../package.json", import.meta.url);
    const json = JSON.parse(readFileSync(fileURLToPath(root), "utf8")) as { version?: string };
    return typeof json.version === "string" ? json.version : "unknown";
  } catch {
    return "unknown";
  }
}

const APP_VERSION = readAppVersion();

/**
 * Map a configured object-storage endpoint to a short provider label (no credentials, just the
 * vendor). Empty/undefined endpoint ⇒ null (no object storage configured). An unrecognised
 * S3-compatible endpoint degrades to the generic "s3" label.
 */
export function storageLabel(endpoint: string | undefined | null): string | null {
  const ep = (endpoint ?? "").trim().toLowerCase();
  if (!ep) return null;
  if (ep.includes("backblazeb2.com") || ep.includes("backblaze")) return "b2";
  if (ep.includes("r2.cloudflarestorage.com") || ep.includes("cloudflare")) return "r2";
  return "s3";
}

/** The Bun/Node runtime version string, however this process was launched. */
function runtimeVersion(): string {
  const bunGlobal = (globalThis as { Bun?: { version?: string } }).Bun;
  return bunGlobal?.version ?? process.versions.bun ?? process.version;
}

export interface DeploymentInfo {
  app_version: string;
  runtime: "bun";
  runtime_version: string;
  os: string;
  arch: string;
  cpu_count: number;
  mem_total_mb: number;
  node_env: string;
  registration_enabled: boolean;
  history_retention_days: number;
  /** DISTINCT platforms across connected channels; falls back to the configured set when none. */
  platforms_enabled: string[];
  integrations: {
    google: boolean;
    ai: boolean;
    /** Short label of the configured object storage ("b2" / "r2" / "s3"), or null when unset. */
    storage: string | null;
  };
}

const truthy = (v: string) => ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());

/** The platforms the instance is configured to use, used only as a fallback when no channel is yet
 *  connected. Tied to actual config: Meta unlocks facebook+instagram, Google unlocks youtube. */
function configuredPlatforms(): string[] {
  const out: string[] = [];
  if (env.META_APP_ID) out.push("facebook", "instagram");
  if (env.GOOGLE_CLIENT_ID) out.push("youtube");
  return out;
}

/**
 * Deployment facts about THIS instance — versions, host shape, deployment flags and integration
 * presence. Booleans/labels/versions/counts only; no secret ever appears here.
 */
export function collectDeployment(distinctChannelPlatforms?: string[]): DeploymentInfo {
  const channelPlatforms = distinctChannelPlatforms ?? [];
  return {
    app_version: APP_VERSION,
    runtime: "bun",
    runtime_version: runtimeVersion(),
    os: process.platform,
    arch: process.arch,
    cpu_count: os.cpus().length,
    mem_total_mb: Math.round(os.totalmem() / 1024 / 1024),
    node_env: env.NODE_ENV,
    registration_enabled: truthy(env.REGISTRATION_ENABLED),
    history_retention_days: env.HISTORY_RETENTION_DAYS,
    platforms_enabled: channelPlatforms.length > 0 ? channelPlatforms : configuredPlatforms(),
    integrations: {
      google: Boolean(env.GOOGLE_CLIENT_ID),
      ai: Boolean(env.AI_API_KEY || env.OPENAI_API_KEY),
      storage: storageLabel(env.STORAGE_ENDPOINT),
    },
  };
}

export interface MetricsInfo {
  workspaces: number;
  channels: { total: number; by_platform: Partial<Record<Platform, number>>; needs_reauth: number };
  contacts: number;
  conversations: number;
  rules: number;
  sequences: number;
  webhooks_processed: { total: number; last_24h: number; by_status: Record<string, number>; by_platform: Record<string, number> };
  messages_sent: { total: number; last_24h: number; by_platform: Record<string, number> };
  comments_replied: { total: number; by_platform: Record<string, number> };
  response_times: {
    window_days: number;
    answer_rate_pct: number;
    avg_first_response_ms: number | null;
    p50_bucket: string | null;
    p90_bucket: string | null;
    by_thread_type: Record<string, { answer_rate_pct: number; avg_first_response_ms: number | null }>;
  };
  // Open/extensible: future counters can be added without a wire-format break.
  [key: string]: unknown;
}

/** A single COUNT(*) over a table, optionally filtered — mirrors the count() pattern used elsewhere. */
async function countRows(exec: Executor, table: PgTable, where?: SQL): Promise<number> {
  const q = exec.select({ n: count() }).from(table);
  const [row] = await (where ? q.where(where) : q);
  return Number(row?.n ?? 0);
}

/**
 * Instance-wide usage metrics, summed across every workspace. Cheap grouped COUNT(*) queries plus the
 * existing live∪stats unions for all-time webhook counts and the instance-wide response times. No
 * per-person data (ids, names, message text) is read — only aggregate numbers.
 */
export async function collectMetrics(exec: Executor, now: Date = new Date()): Promise<MetricsInfo> {
  const since24h = new Date(now.getTime() - DAY_MS);

  const [
    workspaceCount,
    contactCount,
    conversationCount,
    ruleCount,
    sequenceCount,
    channelTotal,
    channelNeedsReauth,
    messagesSentTotal,
    messagesSentLast24h,
    commentsRepliedTotal,
    channelByPlatform,
    messagesSentByPlatform,
    commentsRepliedByPlatform,
    liveWebhookByStatus,
    statsWebhookByStatus,
    liveWebhookByPlatform,
    statsWebhookByPlatform,
    webhookLast24h,
    responseTimes,
  ] = await Promise.all([
    countRows(exec, workspaces),
    countRows(exec, contacts),
    countRows(exec, conversations),
    countRows(exec, autoReplyRules),
    countRows(exec, sequences),
    countRows(exec, channels),
    countRows(exec, channels, eq(channels.status, "needs_reauth")),
    countRows(exec, outboundDeliveries, eq(outboundDeliveries.status, "sent")),
    countRows(exec, outboundDeliveries, and(eq(outboundDeliveries.status, "sent"), gt(outboundDeliveries.updated_at, since24h))),
    countRows(exec, commentLogs, eq(commentLogs.reply_sent, true)),
    // One grouped query for channels-by-platform (no N+1).
    exec.select({ platform: channels.platform, n: sql<number>`count(*)::int` }).from(channels).groupBy(channels.platform),
    // Sent outbound + sent comment replies, grouped by the channel's platform (a single join, no N+1).
    exec.select({ platform: channels.platform, n: sql<number>`count(*)::int` })
      .from(outboundDeliveries)
      .innerJoin(channels, eq(outboundDeliveries.channel_id, channels.id))
      .where(eq(outboundDeliveries.status, "sent"))
      .groupBy(channels.platform),
    exec.select({ platform: channels.platform, n: sql<number>`count(*)::int` })
      .from(commentLogs)
      .innerJoin(channels, eq(commentLogs.channel_id, channels.id))
      .where(eq(commentLogs.reply_sent, true))
      .groupBy(channels.platform),
    // All-time webhook counts: live grouped ∪ rolled-up stats, reusing the existing merge helpers.
    exec.select({ status: webhookEvents.handling_status, n: sql<number>`count(*)::int` }).from(webhookEvents).groupBy(webhookEvents.handling_status),
    exec.select({ handling_status: webhookEventStats.handling_status, count: sql<number>`sum(${webhookEventStats.count})::int` }).from(webhookEventStats).groupBy(webhookEventStats.handling_status),
    exec.select({ platform: webhookEvents.platform, n: sql<number>`count(*)::int` }).from(webhookEvents).groupBy(webhookEvents.platform),
    exec.select({ platform: webhookEventStats.platform, count: sql<number>`sum(${webhookEventStats.count})::int` }).from(webhookEventStats).groupBy(webhookEventStats.platform),
    exec.select({ n: sql<number>`count(*)::int` }).from(webhookEvents).where(gt(webhookEvents.received_at, since24h)),
    getInstanceResponseTimeStats(exec, { windowDays: DEFAULT_WINDOW_DAYS, now }),
  ]);

  const byPlatform: Partial<Record<Platform, number>> = {};
  for (const r of channelByPlatform) byPlatform[r.platform] = Number(r.n);

  const platformCounts = (rows: { platform: Platform | null; n: number }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rows) if (r.platform) out[r.platform] = Number(r.n);
    return out;
  };
  const messagesSentPlatform = platformCounts(messagesSentByPlatform);
  const commentsRepliedPlatform = platformCounts(commentsRepliedByPlatform);

  const byStatus = mergeWebhookStatusCounts(
    liveWebhookByStatus.map((r) => ({ status: r.status, n: Number(r.n) })),
    statsWebhookByStatus.map((r) => ({ handling_status: r.handling_status, count: Number(r.count) })),
  );
  const webhookTotal = Object.values(byStatus).reduce((a, n) => a + n, 0);
  const webhookByPlatform = mergeWebhookPlatformCounts(
    liveWebhookByPlatform.map((r) => ({ platform: r.platform, n: Number(r.n) })),
    statsWebhookByPlatform.map((r) => ({ platform: r.platform, count: Number(r.count) })),
  );

  const byThreadType: MetricsInfo["response_times"]["by_thread_type"] = {};
  for (const [k, v] of Object.entries(responseTimes.by_thread_type)) {
    if (v) byThreadType[k] = { answer_rate_pct: v.answer_rate_pct, avg_first_response_ms: v.avg_first_response_ms };
  }

  return {
    workspaces: workspaceCount,
    channels: { total: channelTotal, by_platform: byPlatform, needs_reauth: channelNeedsReauth },
    contacts: contactCount,
    conversations: conversationCount,
    rules: ruleCount,
    sequences: sequenceCount,
    webhooks_processed: {
      total: webhookTotal,
      last_24h: Number(webhookLast24h[0]?.n ?? 0),
      by_status: byStatus,
      by_platform: webhookByPlatform,
    },
    messages_sent: { total: messagesSentTotal, last_24h: messagesSentLast24h, by_platform: messagesSentPlatform },
    comments_replied: { total: commentsRepliedTotal, by_platform: commentsRepliedPlatform },
    response_times: {
      window_days: responseTimes.window_days,
      answer_rate_pct: responseTimes.overall.answer_rate_pct,
      avg_first_response_ms: responseTimes.overall.avg_first_response_ms,
      p50_bucket: responseTimes.overall.p50_bucket,
      p90_bucket: responseTimes.overall.p90_bucket,
      by_thread_type: byThreadType,
    },
  };
}

export interface TelemetryEnvelope {
  schema_version: 1;
  project: string;
  instance_id: string;
  sent_at: string;
  identity: {
    domain_hash: string;
    license_hash: string | null;
    license_tier: string | null;
  };
  deployment: DeploymentInfo;
  metrics: MetricsInfo;
}

/**
 * Build the full versioned telemetry envelope: the hashed instance/domain/license identity, the
 * deployment facts, and the instance-wide usage metrics. The only identifiers are one-way hashes —
 * the raw domain, license order id and every per-person field stay out of the payload entirely.
 */
export async function buildEnvelope(exec: Executor, now: Date = new Date()): Promise<TelemetryEnvelope> {
  const [instanceId, license, metrics] = await Promise.all([
    ensureInstanceId(exec),
    getLicenseIdentity(),
    collectMetrics(exec, now),
  ]);
  const deployment = collectDeployment(Object.keys(metrics.channels.by_platform));
  return {
    schema_version: 1,
    project: TELEMETRY_PROJECT,
    instance_id: instanceId,
    sent_at: now.toISOString(),
    identity: {
      domain_hash: domainHash(env.APP_URL),
      license_hash: license.licenseHash,
      license_tier: license.licenseTier,
    },
    deployment,
    metrics,
  };
}
