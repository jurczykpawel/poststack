import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { outgoingMessagesQueue } from "@/lib/queue/client";
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
}

/**
 * Evaluate all active rules for a workspace/channel and fire the first match.
 * Rules are sorted by priority (DESC) then created_at (ASC).
 * Returns the matched rule id, or null if no rule fired.
 */
export async function evaluateRules(
  input: EvaluateRulesInput
): Promise<string | null> {
  const { workspaceId, channelId, conversationId, contactId, recipientPlatformId, text, eventType, postId } = input;

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

    if (!matchRule(candidate, { text, eventType, postId })) continue;

    // Cooldown: atomic Redis SETNX prevents concurrent messages from firing the same rule
    if (rule.cooldown_seconds > 0) {
      const lockKey = `cooldown:${rule.id}:${contactId}`;
      const acquired = await redis.set(lockKey, "1", "EX", rule.cooldown_seconds, "NX");
      if (!acquired) continue; // Another message already fired this rule within the cooldown window
    }

    // Fire the response
    await fireResponse({
      rule: candidate,
      channelId,
      conversationId,
      contactId,
      recipientPlatformId,
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

  const tone = (config.tone as string) ?? "friendly and professional";

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
          {
            role: "system",
            content: `You rephrase messages to sound natural and varied while keeping the same meaning and intent. Tone: ${tone}. Reply with ONLY the rephrased message, nothing else. Keep it similar length. Do not add greetings or sign-offs unless the original has them.`,
          },
          {
            role: "user",
            content: baseText,
          },
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
  const { rule, channelId, conversationId, contactId, recipientPlatformId } = input;

  switch (rule.response_type) {
    case "text": {
      const text = rule.response_config.text as string | undefined;
      if (!text) break;
      await outgoingMessagesQueue.add("outgoing-message", {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        content: { text },
        sentByRuleId: rule.id,
        idempotencyKey: randomUUID(),
      });
      break;
    }

    case "random_text": {
      const msgs = rule.response_config.messages as string[] | undefined;
      if (!msgs || msgs.length === 0) break;
      const text = msgs[Math.floor(Math.random() * msgs.length)];
      await outgoingMessagesQueue.add("outgoing-message", {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        content: { text },
        sentByRuleId: rule.id,
        idempotencyKey: randomUUID(),
      });
      break;
    }

    case "ai_rephrase": {
      const baseText = rule.response_config.text as string | undefined;
      if (!baseText) break;
      const rephrased = await rephraseWithAI(baseText, rule.response_config);
      await outgoingMessagesQueue.add("outgoing-message", {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        content: { text: rephrased },
        sentByRuleId: rule.id,
        idempotencyKey: randomUUID(),
      });
      break;
    }

    case "none":
      // Intentionally no message — useful for action-only rules
      break;

    default:
      break;
  }
}
