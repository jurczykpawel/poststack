import { prisma } from "@/lib/prisma";
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
}

/**
 * Evaluate all active rules for a workspace/channel and fire the first match.
 * Rules are sorted by priority (DESC) then created_at (ASC).
 * Returns the matched rule id, or null if no rule fired.
 */
export async function evaluateRules(
  input: EvaluateRulesInput
): Promise<string | null> {
  const { workspaceId, channelId, conversationId, contactId, recipientPlatformId, text, eventType } = input;

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

    if (!matchRule(candidate, text, eventType)) continue;

    // Check cooldown: don't fire the same rule for the same contact too often
    if (rule.cooldown_seconds > 0) {
      const cooldownStart = new Date(Date.now() - rule.cooldown_seconds * 1000);
      const recentMessage = await prisma.message.findFirst({
        where: {
          conversation: { contact_id: contactId },
          sent_by_rule_id: rule.id,
          created_at: { gte: cooldownStart },
        },
        select: { id: true },
      });
      if (recentMessage) continue;
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
