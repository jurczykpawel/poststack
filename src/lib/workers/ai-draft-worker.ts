import type { JobHelpers } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, workspaces, pendingApprovals, outboundDeliveries } from "@/db/schema";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/api/rate-limit";
import { generateDraft, resolveDraftPrompt } from "@/lib/ai/draft";
import { buildProposedContent, proposedHasDm, proposedHasComment, type ProposedContent } from "@/lib/approvals/draft";
import { enqueueCommentReply, enqueueDmReply } from "@/lib/approvals/send";
import type { AiDraftJob } from "@/lib/queue/types";

/**
 * AIDRAFT1: generate an AI auto-reply draft for a matching inbound and decide its fate in ONE
 * transaction — autosend the surface(s) flagged for autosend (reusing the approve handler's
 * send-enqueue path), and park the rest as a single `pending_approvals` row (source = job.source,
 * no originating rule). All-autosent → no approval row; none-autosent → one row with all parts.
 *
 * Idempotency: anchored on `helpers.job.id` via an `outbound_deliveries` marker (task_name
 * `ai-draft`), mirroring the follow-gate worker. A redelivery after a committed run short-circuits
 * BEFORE the (paid) LLM call, so it never double-generates, double-inserts an approval, or
 * double-enqueues a send. The autosent jobs additionally carry deterministic job/idempotency keys,
 * so even an in-flight retry collapses downstream.
 */
export async function processAiDraft(job: AiDraftJob, helpers: JobHelpers): Promise<void> {
  const anchor = `ai-draft:${helpers.job.id}`;

  // Idempotency short-circuit: a prior run already processed this draft (marker written in its tx).
  const prior = await db.query.outboundDeliveries.findFirst({
    where: eq(outboundDeliveries.delivery_key, anchor),
    columns: { id: true },
  });
  if (prior) {
    helpers.logger.info(`ai-draft ${anchor} already processed — skipping`);
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

  const sendDm = hasDm && channel.ai_draft_autosend_dm;
  const sendComment = hasComment && channel.ai_draft_autosend_public;

  // Parts NOT flagged for autosend are parked together in ONE approval row.
  const held: ProposedContent = {};
  if (hasDm && !sendDm) held.content = proposed.content;
  if (hasComment && !sendComment) held.comment = proposed.comment;
  const holdSomething = !!held.content || !!held.comment;

  await db.transaction(async (tx) => {
    // Idempotency marker (the draft-decision record). onConflictDoNothing so a racing redelivery is a
    // no-op rather than a unique-violation.
    await tx
      .insert(outboundDeliveries)
      .values({
        delivery_key: anchor,
        workspace_id: job.workspaceId,
        channel_id: job.channelId,
        contact_id: job.contactId,
        task_name: "ai-draft",
        payload: { ...job },
        status: "sent",
        attempts: 1,
        updated_at: new Date(),
      })
      .onConflictDoNothing({ target: outboundDeliveries.delivery_key });

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
