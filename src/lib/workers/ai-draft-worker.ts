import type { JobHelpers } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, workspaces, pendingApprovals } from "@/db/schema";
import { env } from "@/lib/env";
import { hasFeature } from "@/lib/license/gate";
import { rateLimit } from "@/lib/api/rate-limit";
import { generateDraft, resolveDraftPrompt } from "@/lib/ai/draft";
import { buildProposedContent, proposedHasDm, proposedHasComment, type ProposedContent } from "@/lib/approvals/draft";
import { enqueueCommentReply, enqueueDmReply } from "@/lib/approvals/send";
import { isContactSubscribed } from "@/lib/contacts/consent";
import { claimJobOnce, isJobClaimed } from "@/lib/queue/idempotency";
import type { AiDraftJob } from "@/lib/queue/types";

/**
 * AIDRAFT1: generate an AI auto-reply draft for a matching inbound and decide its fate in ONE
 * transaction — autosend the surface(s) flagged for autosend (reusing the approve handler's
 * send-enqueue path), and park the rest as a single `pending_approvals` row (source = job.source,
 * no originating rule). All-autosent → no approval row; none-autosent → one row with all parts.
 *
 * Consent: an autosend re-checks `contacts.is_subscribed` (like the approve handler + outgoing/
 * sequence/follow-gate workers) BEFORE sending, because the comment→DM (private-reply) and public
 * surfaces have no consent gate of their own. An unsubscribed contact is never DM'd — the part is
 * parked for human review instead of silently dropped.
 *
 * Idempotency: anchored on `helpers.job.id` via a `rate_limit_counters` marker (a keyed KV that
 * stats/telemetry do NOT read — a deliberate move away from the old `outbound_deliveries` marker,
 * which `stats/overview` + `telemetry/collect` counted as a sent message). The marker is claimed
 * INSIDE the work tx, so a redelivery only short-circuits after a committed run: it never
 * double-generates (a pre-LLM read skips early), double-inserts an approval, or double-enqueues a
 * send. The autosent jobs additionally carry deterministic job/idempotency keys, so even an
 * in-flight retry collapses downstream, and the real 'sent' row is written once by the delivery
 * worker.
 */
export async function processAiDraft(job: AiDraftJob, helpers: JobHelpers): Promise<void> {
  const anchor = `ai-draft:${helpers.job.id}`;

  // Idempotency short-circuit: a prior run already committed this draft (marker written in its tx).
  // Cheap pre-LLM read so a redelivery never re-pays for generation; the authoritative claim is the
  // in-tx `claimJobOnce` below.
  if (await isJobClaimed(anchor)) {
    helpers.logger.info(`ai-draft ${anchor} already processed — skipping`);
    return;
  }

  // PRO gate (worker-side). AI drafting is a PRO feature, gated on the on-demand button (T6) and the
  // config-persist routes (T8). The AUTO no-match path, however, enqueues an ai-draft job regardless
  // of license — so a free instance would otherwise reach the LLM here. Gate generation BEFORE paying
  // for it: a free instance creates no draft, no approval row, no charge. The license is instance-
  // global (one verdict for all workspaces), verified offline; fails closed to free.
  if (!(await hasFeature("ai_draft"))) {
    helpers.logger.info(`ai-draft ${anchor}: ai_draft not licensed — skipping generation`);
    return;
  }

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, job.channelId),
    columns: { ai_draft_prompt: true, ai_draft_autosend_dm: true, ai_draft_autosend_public: true },
  });
  if (!channel) {
    helpers.logger.info(`ai-draft: channel ${job.channelId} not found — skipping`);
    return;
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, job.workspaceId),
    columns: { ai_draft_prompt: true },
  });
  const prompt = resolveDraftPrompt({
    channelPrompt: channel.ai_draft_prompt,
    workspacePrompt: workspace?.ai_draft_prompt,
  });

  // Per-workspace daily budget for draft generation. 0 = unlimited (BYOK / self-hosted). Over the
  // rolling-24h cap, skip entirely: no draft, no approval row, no charge to the model.
  if (env.AI_DRAFT_DAILY_LIMIT > 0) {
    const { allowed } = await rateLimit(`rl:llm-draft:${job.workspaceId}`, env.AI_DRAFT_DAILY_LIMIT, 86_400);
    if (!allowed) {
      helpers.logger.info(`ai-draft: workspace ${job.workspaceId} over daily limit — skipping`);
      return;
    }
  }

  const draft = await generateDraft({ incomingText: job.incomingText, context: job.context, prompt });
  if (!draft || !draft.trim()) {
    // No usable completion (no key / failure / empty) → create NOTHING, not an empty approval.
    helpers.logger.info(`ai-draft ${anchor}: empty generation — nothing parked`);
    return;
  }

  const proposed = buildProposedContent({ target: job.target, draftText: draft, commentId: job.commentId });
  const hasDm = proposedHasDm(proposed.content);
  const hasComment = proposedHasComment(proposed.comment);
  if (!hasDm && !hasComment) {
    helpers.logger.info(`ai-draft ${anchor}: target ${job.target} produced no sendable part — skipping`);
    return;
  }

  // On-demand drafts (`ai_manual`, the inbox "Generate reply" button) are ALWAYS held for approval —
  // an explicit human request is never autosent, regardless of the channel's autosend flags. Only the
  // pipeline path (`ai_auto`) honours autosend.
  const manualHold = job.source === "ai_manual";
  let sendDm = !manualHold && hasDm && channel.ai_draft_autosend_dm;
  let sendComment = !manualHold && hasComment && channel.ai_draft_autosend_public;

  await db.transaction(async (tx) => {
    // Claim the job atomically inside the work tx (rate_limit_counters KV — NOT outbound_deliveries,
    // which stats/telemetry count). A racing/already-committed redelivery fails to claim and bails
    // out before re-enqueuing a send or re-parking an approval.
    const claimed = await claimJobOnce(tx, anchor);
    if (!claimed) {
      helpers.logger.info(`ai-draft ${anchor}: concurrent redelivery already claimed — skipping`);
      return;
    }

    // Consent gate on autosend ONLY (parking already defers to the approve handler's gate at send
    // time). An unsubscribed contact must not be DM'd via the private-reply/public surfaces — those
    // have no consent gate. Mirror the approve handler: don't send, PARK the part instead so a human
    // can still see/act on it (never silently dropped). One caller-side gate covers every surface.
    // Read INSIDE the work tx (tx executor) so the subscribed-check and the send-enqueue are atomic —
    // matching the approve handler — closing the sub-ms window between an out-of-tx read and the enqueue.
    if ((sendDm || sendComment) && !(await isContactSubscribed(tx, job.contactId))) {
      helpers.logger.info(`ai-draft ${anchor}: contact ${job.contactId} unsubscribed — parking instead of autosend`);
      sendDm = false;
      sendComment = false;
    }

    // Parts NOT flagged for autosend are parked together in ONE approval row.
    const held: ProposedContent = {};
    if (hasDm && !sendDm) held.content = proposed.content;
    if (hasComment && !sendComment) held.comment = proposed.comment;
    const holdSomething = !!held.content || !!held.comment;

    if (sendComment) {
      await enqueueCommentReply(tx, {
        channelId: job.channelId,
        contactId: job.contactId,
        comment: { text: proposed.comment!.text!, commentId: proposed.comment!.commentId! },
        keys: { jobKey: `${anchor}-comment`, idempotencyKey: `${anchor}:comment` },
      });
    }
    if (sendDm) {
      await enqueueDmReply(tx, {
        channelId: job.channelId,
        conversationId: job.conversationId,
        contactId: job.contactId,
        recipientPlatformId: job.recipientPlatformId,
        content: proposed.content!,
        commentId: job.commentId,
        keys: { jobKey: `${anchor}-dm`, idempotencyKey: `${anchor}:dm` },
      });
    }

    if (holdSomething) {
      await tx.insert(pendingApprovals).values({
        workspace_id: job.workspaceId,
        rule_id: null,
        source: job.source,
        conversation_id: job.conversationId,
        contact_id: job.contactId,
        channel_id: job.channelId,
        recipient_platform_id: job.recipientPlatformId,
        proposed_content: JSON.parse(JSON.stringify(held)),
      });
    }
  });

  helpers.logger.info(
    `ai-draft ${anchor}: target=${job.target} dm=${sendDm ? "sent" : hasDm ? "parked" : "-"} ` +
      `comment=${sendComment ? "sent" : hasComment ? "parked" : "-"}`,
  );
}
