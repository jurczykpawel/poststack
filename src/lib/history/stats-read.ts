// RETAIN1 read-path: merge live rows with compaction aggregates so all-time UI numbers stay correct
// after old raw rows are folded away. Pure (no DB) → unit-tested in isolation.

export interface LiveStatusRow { status: string; n: number }
export interface WebhookStatRow { handling_status: string; count: number }

/** All-time count per handling_status = live grouped counts + aggregate counts. */
export function mergeWebhookStatusCounts(live: LiveStatusRow[], stats: WebhookStatRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of live) out[r.status] = (out[r.status] ?? 0) + Number(r.n);
  for (const r of stats) out[r.handling_status] = (out[r.handling_status] ?? 0) + Number(r.count);
  return out;
}

export interface LivePlatformRow { platform: string | null; n: number }
export interface PlatformStatRow { platform: string | null; count: number }

/** All-time count per platform = live grouped counts + aggregate counts. Rows whose platform is null
 *  (an old event whose page→channel was never resolved) are unattributed and dropped from the breakdown. */
export function mergeWebhookPlatformCounts(live: LivePlatformRow[], stats: PlatformStatRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of live) if (r.platform) out[r.platform] = (out[r.platform] ?? 0) + Number(r.n);
  for (const r of stats) if (r.platform) out[r.platform] = (out[r.platform] ?? 0) + Number(r.count);
  return out;
}
