import { randomUUID } from "crypto";
import { and, or, eq, isNull, desc, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { autoReplyRules, pendingApprovals } from "@/db/schema";
import { acquireCooldown, incrementSendCount } from "./limits";
import { addJob } from "@/lib/queue/client";
import { rephrase } from "@/lib/ai/rephrase";
import { matchRule } from "./matcher";
import type { EventType } from "./matcher";
import { selectResponse, buildInteractiveContent } from "./response";
import type { MessageContent } from "@/lib/platforms/base";

/**
 * Resolve a rule's reply text: pick the base (single or random from a pool),
 * then optionally rephrase it through the LLM. Shared by the live send path
 * and the approval-park path so both produce identical wording.
 */
async function resolveDmText(
  responseType: string,
  responseConfig: Record<string, unknown>,
): Promise<string | null> {
  const { baseText, aiEnabled } = selectResponse(responseType, responseConfig);
  if (aiEnabled && baseText) {
    return rephrase(baseText, {
      customPrompt: responseConfig.custom_prompt as string | undefined,
      tone: responseConfig.tone as string | undefined,
    });
  }
  return baseText;
}

/**
 * Resolve the full DM content (text + interactive add-ons) a rule would send.
 * Returns null when there is no text to send. Used to park an approvable,
 * ready-to-send message so the human approves exactly what goes out.
 */
export async function resolveReplyContent(
  responseType: string,
  responseConfig: Record<string, unknown>,
): Promise<MessageContent | null> {
  const text = await resolveDmText(responseType, responseConfig);
  if (!text) return null;
  return { text, ...buildInteractiveContent(responseConfig) };
}

interface EvaluateRulesInput {
  workspaceId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
  text: string | null;
  eventType: EventType;
  /** Post/media ID for comment_keyword post scoping */
  postId?: string;
  /** Comment ID for public comment reply */
  commentId?: string;
  quickReplyPayload?: string;
  postbackPayload?: string;
  isStoryReply?: boolean;
  isStoryMention?: boolean;
  isReaction?: boolean;
  reactionType?: string;
}

/**
 * Evaluate all active rules for a workspace/channel and fire the first match.
 * Rules are sorted by priority (DESC) then created_at (ASC).
 * Returns the matched rule id, or null if no rule fired.
 */
export async function evaluateRules(
  input: EvaluateRulesInput
): Promise<string | null> {
  const { workspaceId, channelId, conversationId, contactId, recipientPlatformId, text, eventType, postId, commentId, quickReplyPayload, postbackPayload, isStoryReply, isStoryMention, isReaction, reactionType } = input;

  const rules = await db.query.autoReplyRules.findMany({
    where: and(
      eq(autoReplyRules.workspace_id, workspaceId),
      eq(autoReplyRules.is_active, true),
      or(eq(autoReplyRules.channel_id, channelId), isNull(autoReplyRules.channel_id)),
    ),
    orderBy: [desc(autoReplyRules.priority), asc(autoReplyRules.created_at)],
    columns: {
      id: true,
      is_active: true,
      priority: true,
      cooldown_seconds: true,
      max_sends_per_contact: true,
      requires_approval: true,
      trigger_type: true,
      trigger_config: true,
      response_type: true,
      response_config: true,
      actions: true,
    },
  });

  for (const rule of rules) {
    const candidate = {
      ...rule,
      trigger_config: rule.trigger_config as Record<string, unknown>,
      response_config: rule.response_config as Record<string, unknown>,
      actions: rule.actions as unknown[],
    };

    if (!matchRule(candidate, { text, eventType, postId, quickReplyPayload, postbackPayload, isStoryReply, isStoryMention, isReaction, reactionType })) continue;

    // Cooldown: atomic acquire prevents concurrent events from firing the same rule
    if (!(await acquireCooldown(rule.id, contactId, rule.cooldown_seconds))) continue;

    // Per-rule lifetime send limit: atomic increment-if-under-cap
    if (
      rule.max_sends_per_contact != null &&
      !(await incrementSendCount(rule.id, contactId, rule.max_sends_per_contact))
    ) {
      continue;
    }

    // Manual approval: park a ready-to-send message for human review instead
    // of auto-sending. Store the resolved content so the approver acts on the
    // exact text/buttons that will go out (DM path; comment/follow-gate
    // approval is out of scope for now).
    if (rule.requires_approval) {
      const content = await resolveReplyContent(rule.response_type, candidate.response_config);
      await db.insert(pendingApprovals).values({
        workspace_id: workspaceId,
        rule_id: rule.id,
        conversation_id: conversationId,
        contact_id: contactId,
        channel_id: channelId,
        recipient_platform_id: recipientPlatformId,
        proposed_content: JSON.parse(JSON.stringify({ content })),
      });
      return rule.id;
    }

    // Fire the response
    await fireResponse({
      rule: candidate,
      channelId,
      conversationId,
      contactId,
      recipientPlatformId,
      commentId,
    });

    return rule.id;
  }

  return null;
}

interface FireResponseInput {
  rule: {
    id: string;
    response_type: string;
    response_config: Record<string, unknown>;
    actions: unknown[];
  };
  channelId: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
  commentId?: string;
}

/** Build outbound content from a follow-gate branch config ({ text, quick_replies?, buttons? }). */
function gatedContent(branch: unknown) {
  const cfg = (branch ?? {}) as Record<string, unknown>;
  return { text: cfg.text as string | undefined, ...buildInteractiveContent(cfg) };
}

async function fireResponse(input: FireResponseInput): Promise<void> {
  const { rule, channelId, conversationId, contactId, recipientPlatformId, commentId } = input;

  // Follow-gate: defer to a worker that re-checks follow status live, then
  // sends the lead magnet or a re-prompt. Stateless — driven by each tap.
  if (rule.response_type === "follow_gate") {
    await addJob("follow-gate", {
      channelId,
      conversationId,
      contactId,
      recipientPlatformId,
      followed: gatedContent(rule.response_config.followed),
      notFollowed: gatedContent(rule.response_config.not_followed),
      sentByRuleId: rule.id,
      idempotencyKey: randomUUID(),
    });
    return;
  }

  const replyMode = (rule.response_config.reply_mode as string) ?? "dm";

  // Resolve the text to send (single or random pick, optionally LLM-rephrased).
  const dmText = await resolveDmText(rule.response_type, rule.response_config);

  // Public comment reply (reply_mode: "comment" or "both")
  let commentSent = false;
  if ((replyMode === "comment" || replyMode === "both") && commentId) {
    const commentReplyText = (rule.response_config.comment_reply_text as string) ?? dmText;
    if (commentReplyText) {
      await addJob("outgoing-comment", {
        channelId,
        commentId,
        text: commentReplyText,
        sentByRuleId: rule.id,
        idempotencyKey: randomUUID(),
      });
      commentSent = true;
    }
  }

  // Interactive add-ons (quick replies / buttons) attach to the DM body.
  const interactive = buildInteractiveContent(rule.response_config);
  const hasInteractive = interactive.quick_replies !== undefined || interactive.buttons !== undefined;

  // DM: send when reply_mode=dm, reply_mode=both, or fallback when comment failed (no commentId)
  const shouldDM = replyMode === "dm" || replyMode === "both" || (replyMode === "comment" && !commentSent);
  if (shouldDM && dmText) {
    if (commentId) {
      // Comment-triggered DM: addressed by comment_id (works first-touch, no PSID needed).
      await addJob("outgoing-private-reply", {
        channelId,
        conversationId,
        commentId,
        text: dmText,
        ...(hasInteractive ? { content: { text: dmText, ...interactive } } : {}),
        sentByRuleId: rule.id,
        idempotencyKey: randomUUID(),
      });
    } else {
      await addJob("outgoing-message", {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        content: { text: dmText, ...interactive },
        sentByRuleId: rule.id,
        idempotencyKey: randomUUID(),
      });
    }
  }

}
