import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { acquireCooldown, incrementSendCount } from "./limits";
import { addJob } from "@/lib/queue/client";
import { matchRule } from "./matcher";
import type { EventType } from "./matcher";

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
}

/**
 * Evaluate all active rules for a workspace/channel and fire the first match.
 * Rules are sorted by priority (DESC) then created_at (ASC).
 * Returns the matched rule id, or null if no rule fired.
 */
export async function evaluateRules(
  input: EvaluateRulesInput
): Promise<string | null> {
  const { workspaceId, channelId, conversationId, contactId, recipientPlatformId, text, eventType, postId, commentId, quickReplyPayload, postbackPayload } = input;

  const rules = await prisma.autoReplyRule.findMany({
    where: {
      workspace_id: workspaceId,
      is_active: true,
      OR: [{ channel_id: channelId }, { channel_id: null }],
    },
    orderBy: [{ priority: "desc" }, { created_at: "asc" }],
    select: {
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

    if (!matchRule(candidate, { text, eventType, postId, quickReplyPayload, postbackPayload })) continue;

    // Cooldown: atomic acquire prevents concurrent events from firing the same rule
    if (!(await acquireCooldown(rule.id, contactId, rule.cooldown_seconds))) continue;

    // Per-rule lifetime send limit: atomic increment-if-under-cap
    if (
      rule.max_sends_per_contact != null &&
      !(await incrementSendCount(rule.id, contactId, rule.max_sends_per_contact))
    ) {
      continue;
    }

    // Manual approval: queue for human review instead of auto-sending
    if (rule.requires_approval) {
      await prisma.pendingApproval.create({
        data: {
          workspace_id: workspaceId,
          rule_id: rule.id,
          conversation_id: conversationId,
          contact_id: contactId,
          channel_id: channelId,
          recipient_platform_id: recipientPlatformId,
          proposed_content: JSON.parse(JSON.stringify({
            response_type: rule.response_type,
            response_config: candidate.response_config,
          })),
        },
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

/**
 * Rephrase a base message using an LLM to sound natural and varied.
 * Falls back to the original text if the API call fails.
 */
async function rephraseWithAI(
  baseText: string,
  config: Record<string, unknown>
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return baseText;

  const customPrompt = config.custom_prompt as string | undefined;
  const tone = (config.tone as string) ?? "friendly and professional";
  const systemContent = customPrompt
    ? customPrompt
    : `You rephrase messages to sound natural and varied while keeping the same meaning and intent. Tone: ${tone}. Reply with ONLY the rephrased message, nothing else. Keep it similar length. Do not add greetings or sign-offs unless the original has them.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 300,
        temperature: 0.8,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: baseText },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return baseText;

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const rephrased = data.choices?.[0]?.message?.content?.trim();
    return rephrased && rephrased.length > 0 ? rephrased : baseText;
  } catch {
    return baseText;
  }
}

async function fireResponse(input: FireResponseInput): Promise<void> {
  const { rule, channelId, conversationId, contactId, recipientPlatformId, commentId } = input;
  const replyMode = (rule.response_config.reply_mode as string) ?? "dm";

  // Resolve the text to send
  let dmText: string | null = null;
  switch (rule.response_type) {
    case "text":
      dmText = (rule.response_config.text as string) ?? null;
      break;
    case "random_text": {
      const msgs = rule.response_config.messages as string[] | undefined;
      if (msgs && msgs.length > 0) dmText = msgs[Math.floor(Math.random() * msgs.length)];
      break;
    }
    case "ai_rephrase": {
      const baseText = rule.response_config.text as string | undefined;
      if (baseText) dmText = await rephraseWithAI(baseText, rule.response_config);
      break;
    }
    case "none":
      break;
  }

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

  // DM: send when reply_mode=dm, reply_mode=both, or fallback when comment failed (no commentId)
  const shouldDM = replyMode === "dm" || replyMode === "both" || (replyMode === "comment" && !commentSent);
  if (shouldDM && dmText) {
    await addJob("outgoing-message", {
      channelId,
      conversationId,
      contactId,
      recipientPlatformId,
      content: { text: dmText },
      sentByRuleId: rule.id,
      idempotencyKey: randomUUID(),
    });
  }

}
