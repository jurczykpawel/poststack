import type { JobHelpers } from "graphile-worker";
import { and, count, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, channels, posts, type Platform } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { toTokenSet } from "@/lib/providers/token-codec";
import { getProviderForPlatform, subKindForPlatform } from "@/lib/providers";
import { can } from "@/lib/channels/capabilities";
import { provisionAutoReply } from "@/lib/autoreply/provision";
import { hasFeature } from "@/lib/license/gate";
import { TokenInvalidError, PermanentError, TransientError, RateLimitedError } from "@/lib/providers/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";
import { tryConsume } from "@/lib/channels/rate-limit";
import { addJob, addJobTx } from "@/lib/queue/client";
import { getProvider as getInboundProvider } from "@/lib/platforms/registry";
import { processTokenRefresh } from "@/lib/channels/token-refresh";
import { emitEventNow } from "@/lib/events";
import type { PublishRequest } from "@/lib/providers/types";
import { resolveMedia } from "./resolve-media";
import { redactSecrets } from "@/lib/redact";

type DeliveryRow = typeof deliveries.$inferSelect;

async function setStatus(
  id: string,
  status: DeliveryRow["status"],
  extra: Partial<DeliveryRow> = {},
): Promise<void> {
  // PSA13: never persist a token/secret echoed back in a provider error string.
  if (typeof extra.last_error === "string") extra = { ...extra, last_error: redactSecrets(extra.last_error) };
  await db.update(deliveries).set({ status, updated_at: new Date(), ...extra }).where(eq(deliveries.id, id));
}

/** Reflect a delivery's terminal outcome onto the editorial post linked to it (if any). */
async function reflectEditorial(
  deliveryId: string,
  status: string,
  extra: Partial<typeof posts.$inferInsert> = {},
): Promise<void> {
  await db.update(posts).set({ status, updated_at: new Date(), ...extra }).where(eq(posts.delivery_id, deliveryId));
}

/** Terminal failure: mark failed + reflect editorial + emit the event. */
async function failDelivery(deliveryId: string, workspaceId: string, message: string): Promise<void> {
  message = redactSecrets(message); // PSA13
  await setStatus(deliveryId, "failed", { last_error: message });
  await reflectEditorial(deliveryId, "failed");
  await emitEventNow(workspaceId, "post.failed", { type: "post", id: deliveryId }, { error: message }).catch(() => {});
}

/** Land a delivery in `unknown` (indeterminate), but OBSERVABLE (PSA3): event + editorial needs_attention. */
async function markUnknown(deliveryId: string, workspaceId: string, reason: string): Promise<void> {
  reason = redactSecrets(reason); // PSA13
  await setStatus(deliveryId, "unknown");
  await reflectEditorial(deliveryId, "needs_attention");
  await emitEventNow(workspaceId, "post.unknown", { type: "post", id: deliveryId }, { reason }).catch(() => {});
}

/** Deliveries left in `sending` longer than this are surfaced by the recovery sweep (PSA3). */
const STUCK_SENDING_MINUTES = 15;

/** Recovery sweep (PSA3): surface any delivery stuck in `sending` past the window as `unknown`
 *  (instance-wide cron). Returns the count. */
export async function stuckSendingSweep(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_SENDING_MINUTES * 60_000);
  const stuck = await db.query.deliveries.findMany({
    where: and(eq(deliveries.status, "sending"), lt(deliveries.attempt_started_at, cutoff)),
  });
  for (const d of stuck) {
    await markUnknown(d.id, d.workspace_id, "stuck in sending past the recovery window");
  }
  return stuck.length;
}

const RATE_LIMIT_DEFER_BASE_MS = 5_000;

/** Re-enqueue with jittered backoff instead of rethrowing (avoids a synchronized retry storm). PSA14. */
async function deferPublish(postId: string, attempts: number, retryAfterSec?: number): Promise<void> {
  const base = RATE_LIMIT_DEFER_BASE_MS;
  const backoffMs =
    retryAfterSec != null
      ? retryAfterSec * 1000 + Math.floor(Math.random() * base)
      : base * 2 ** Math.min(attempts, 6) + Math.floor(Math.random() * base);
  await addJobTx(db, "publish", { postId }, { runAt: new Date(Date.now() + backoffMs), jobKey: `publish:${postId}` });
}

/** Coarse daily ceiling (PSA14), scoped to the channel. Latent until a provider sets perDay. */
async function withinDailyCap(channelId: string, perDay: number): Promise<boolean> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ n: count() })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.channel_id, channelId),
        inArray(deliveries.status, ["sent", "sending"]),
        gte(deliveries.attempt_started_at, startOfDay),
      ),
    );
  return (row?.n ?? 0) < perDay;
}

/**
 * FIRSTCOMMENT1: enqueue the auto first-comment for a just-published post. Resolves the text
 * (per-post `firstComment` override > channel `default_first_comment`), guards that the platform can
 * post a top-level comment, and keys the delivery to the publish (delivery) id so a retry or
 * re-publish reuses the same ledger row instead of double-posting. Best-effort — the caller swallows
 * failures so a first-comment hiccup never affects the published post.
 */
async function enqueueFirstComment(
  channel: { id: string; platform: Platform; default_first_comment: string | null },
  request: PublishRequest,
  providerPostId: string,
  deliveryId: string,
): Promise<void> {
  const text = (request.firstComment ?? channel.default_first_comment ?? "").trim();
  if (!text || !providerPostId) return;
  // PRO feature (first_comment): a free instance never auto-comments, even if a toggle is still stored
  // on from a lapsed license — the server is the authority, not the (stale) UI state.
  if (!(await hasFeature("first_comment"))) return;
  // Skip platforms whose inbound provider can't post a top-level comment (e.g. TikTok/X/LinkedIn).
  if (!getInboundProvider(channel.platform).commentOnPost) return;
  await addJob(
    "outgoing-first-comment",
    { channelId: channel.id, postId: providerPostId, text, idempotencyKey: `first-comment:${deliveryId}` },
    { jobKey: `first-comment:${deliveryId}` },
  );
}

/**
 * STORY1: enqueue the auto-Story for a just-published post. Resolves the toggle (per-post `autoStory`
 * override > channel `default_auto_story`), guards that the publish provider can post a Story, and
 * keys the delivery to the publish (delivery) id so a retry / re-publish reuses the same ledger row
 * instead of double-posting. Best-effort — the caller swallows failures so a Story hiccup never
 * affects the published post.
 */
async function enqueueAutoStory(
  channel: { id: string; platform: Platform; default_auto_story: boolean },
  request: PublishRequest,
  deliveryId: string,
): Promise<void> {
  const enabled = request.autoStory ?? channel.default_auto_story;
  if (!enabled) return;
  // PRO feature (auto_story): a free instance never auto-publishes a Story, even if the toggle is still
  // stored on from a lapsed license — server-side authority, not the (stale) UI state.
  if (!(await hasFeature("auto_story"))) return;
  // Skip platforms whose publish provider has no Story-publish path (only meta/FB+IG today).
  if (!getProviderForPlatform(channel.platform).publishStory) return;
  await addJob(
    "publish-story",
    { channelId: channel.id, deliveryId, idempotencyKey: `auto-story:${deliveryId}` },
    { jobKey: `auto-story:${deliveryId}` },
  );
}

/**
 * Crash-safe publish (AUD27). Marks `sending` in its own commit before the external call; a
 * definitive failure is classified, a crash leaves `sending` for the retry to reconcile.
 */
export async function processPublish(payload: { postId: string }, helpers: JobHelpers): Promise<void> {
  const { postId } = payload;
  const post = await db.query.deliveries.findFirst({ where: eq(deliveries.id, postId) });
  if (!post) return; // gone
  if (["sent", "failed", "canceled"].includes(post.status)) return; // terminal
  const ws = post.workspace_id;

  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, post.channel_id), isNull(channels.deleted_at)),
  });
  if (!channel || !can({ platform: channel.platform, connection_mode: channel.connection_mode }, "publish")) {
    await setStatus(postId, "failed", { last_error: "channel or provider unavailable" });
    return;
  }

  // Channel down (needs_reauth / paused / disabled) -> park as held (AUD28).
  if (channel.status !== "active") {
    await setStatus(postId, "held");
    await reflectEditorial(postId, "held"); // PSA3
    return;
  }

  const provider = getProviderForPlatform(channel.platform);
  // Route FB-vs-IG for the meta provider: an explicit stored subKind (managed connection) wins,
  // else derive it from the RS platform (facebook→facebook_page, instagram→instagram).
  const channelMetadata: Record<string, unknown> = {
    subKind: subKindForPlatform(channel.platform),
    ...(channel.metadata as Record<string, unknown>),
  };

  // Pre-publish freshness guard (§5C): refresh a soon-to-expire refreshable token inline.
  const FRESH_BUFFER_MS = 5 * 60 * 1000;
  if (
    provider.requiresTokenRefresh() &&
    channel.token_expires_at &&
    channel.token_expires_at.getTime() < Date.now() + FRESH_BUFFER_MS
  ) {
    await processTokenRefresh({ channelId: channel.id }, helpers);
    const fresh = await db.query.channels.findFirst({
      where: and(eq(channels.id, channel.id), isNull(channels.deleted_at)),
    });
    if (!fresh || fresh.status !== "active") {
      await setStatus(postId, "held");
      await reflectEditorial(postId, "held"); // PSA3
      return;
    }
    channel.token_encrypted = fresh.token_encrypted; // use the refreshed token below
  }

  // Crash recovery (AUD27): a retry that finds 'sending' may have sent without recording.
  if (post.status === "sending") {
    if (provider.reconcile) {
      const outcome = await provider.reconcile(toTokenSet(decryptTokens(channel.token_encrypted)), {
        providerHandle: post.provider_handle ?? "",
      });
      if (outcome === "sent") {
        await setStatus(postId, "sent");
        return;
      }
      if (outcome === "not_sent") {
        await setStatus(postId, "scheduled"); // safe to re-send below
      } else {
        await markUnknown(postId, ws, "reconcile returned unknown"); // PSA3
        return;
      }
    } else {
      await markUnknown(postId, ws, "left sending; provider has no reconcile"); // PSA3
      return;
    }
  }

  const rl: { perMinute?: number; perDay?: number } = provider.rateLimit?.() ?? { perMinute: 30 };

  // Daily ceiling (PSA14): checked BEFORE the claim. Latent until a provider sets perDay.
  if (rl.perDay && !(await withinDailyCap(channel.id, rl.perDay))) {
    await deferPublish(postId, post.attempts);
    return;
  }

  // Atomically claim: scheduled -> sending (committed BEFORE the external call).
  const claimed = await db
    .update(deliveries)
    .set({ status: "sending", attempt_started_at: new Date(), attempts: post.attempts + 1, updated_at: new Date() })
    .where(and(eq(deliveries.id, postId), eq(deliveries.status, "scheduled")))
    .returning({ id: deliveries.id });
  if (claimed.length === 0) return; // lost the race / not schedulable (PSA14: consumed no token)
  await reflectEditorial(postId, "publishing"); // mirror in-flight onto editorial

  // Proactive per-minute rate limit — consumed only now THIS worker owns the send (PSA14).
  const cap = rl.perMinute ?? 30;
  if (!(await tryConsume(channel.id, { capacity: cap, refillPerMinute: cap }))) {
    await setStatus(postId, "scheduled");
    await deferPublish(postId, post.attempts);
    return;
  }

  // Pre-mutation step: resolving media happens BEFORE any external publish call (PSA2-safe).
  const request = post.payload as PublishRequest;
  let mediaUrls: string[];
  try {
    mediaUrls = await resolveMedia(request.media, ws);
  } catch (err) {
    if (err instanceof PermanentError) {
      await failDelivery(postId, ws, err.message);
      return;
    }
    await setStatus(postId, "scheduled", { last_error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  try {
    const handle = await provider.publish({
      tokens: toTokenSet(decryptTokens(channel.token_encrypted)),
      accountId: channel.platform_id,
      request,
      mediaUrls,
      channelMetadata,
    });
    await setStatus(postId, "sent", { provider_handle: handle.providerHandle, last_error: null });
    // Capture the platform-assigned post id (the same provider handle used for first-comment / story)
    // onto the editorial post, so a later comment on it can resolve back to this content's title.
    await reflectEditorial(postId, "published", { published_at: new Date(), platform_post_id: handle.providerHandle });
    await emitEventNow(ws, "post.published", { type: "post", id: postId }, { providerHandle: handle.providerHandle, platform: channel.platform });
    // REPLYSTACK1 native (UNIFY P2.2): if the editorial post carries an auto-reply, provision the
    // comment→DM rule scoped to the just-published media id — in-process, idempotent, best-effort.
    await provisionAutoReply(postId, ws).catch(() => {});
    // FIRSTCOMMENT1: auto-post the configured first comment under the new post — separate best-effort
    // delivery so a comment failure never touches the published post.
    await enqueueFirstComment(channel, request, handle.providerHandle, postId).catch(() => {});
    // STORY1: optionally auto-publish a generated Story about the new post — separate best-effort
    // delivery so a Story failure never touches the published post.
    await enqueueAutoStory(channel, request, postId).catch(() => {});
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      // AUD48: leave the post reattemptable FIRST; the channel flag + event are best-effort.
      await setStatus(postId, "held", { last_error: err.message });
      await reflectEditorial(postId, "held").catch(() => {}); // PSA3
      await markChannelNeedsReauth(channel.id, err.message).catch(() => {});
      await emitEventNow(ws, "post.held", { type: "post", id: postId }, { reason: redactSecrets(err.message), platform: channel.platform }).catch(() => {});
      return; // reconnect + drain will retry
    }
    if (err instanceof PermanentError) {
      await failDelivery(postId, ws, err.message);
      return; // no retry
    }
    // PSA36: a pre_commit transient/rate-limited failure provably happened before any irreversible
    // platform mutation — safe to reset to `scheduled` and fully re-run (honoring retry-after).
    if ((err instanceof TransientError || err instanceof RateLimitedError) && err.phase === "pre_commit") {
      await setStatus(postId, "scheduled", { last_error: err.message });
      await deferPublish(postId, post.attempts, err instanceof RateLimitedError ? err.retryAfterSeconds : undefined);
      return;
    }
    // PSA2: anything else may have partially/fully landed on a multi-step provider. Leave `sending`
    // and rethrow — the retry is forced through the reconcile/unknown path, which never re-sends
    // without proof.
    await setStatus(postId, "sending", { last_error: err instanceof Error ? err.message : String(err) });
    helpers.logger.error(redactSecrets(`publish error for post ${postId} (left sending for reconcile): ${String(err)}`));
    throw err;
  }
}
