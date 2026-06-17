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

export interface LiveReactionAgg { postId: string; channelId: string; type: string; n: number; lastAt: Date }
export interface ReactionStatRow { post_id: string; channel_id: string; reaction_type: string; count: number; last_reacted_at: Date }
export interface MergedPost { channelId: string; total: number; types: Map<string, number>; lastAt: Date }

/** Per-post reaction totals = live aggregate ∪ compaction aggregate, summed by reaction type. */
export function mergePostReactionTotals(live: LiveReactionAgg[], stats: ReactionStatRow[]): Map<string, MergedPost> {
  const byPost = new Map<string, MergedPost>();
  const bump = (postId: string, channelId: string, type: string, n: number, at: Date) => {
    let p = byPost.get(postId);
    if (!p) byPost.set(postId, (p = { channelId, total: 0, types: new Map(), lastAt: at }));
    p.total += n;
    p.types.set(type, (p.types.get(type) ?? 0) + n);
    if (at > p.lastAt) p.lastAt = at;
  };
  for (const r of live) bump(r.postId, r.channelId, r.type, Number(r.n), r.lastAt);
  for (const r of stats) bump(r.post_id, r.channel_id, r.reaction_type, Number(r.count), r.last_reacted_at);
  return byPost;
}
