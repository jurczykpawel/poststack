import { randomUUID } from "crypto";
import { and, or, eq, isNull, desc, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { autoReplyRules, pendingApprovals, contacts } from "@/db/schema";
import { acquireCooldown, incrementSendCount, loadRuleLimits } from "./limits";
import { addJobTx } from "@/lib/queue/client";
import { claimEventOnce, isEventProcessed } from "@/lib/idempotency";
import { rephrase } from "@/lib/ai/rephrase";
import { rateLimit } from "@/lib/api/rate-limit";
import { truncateCodePoints } from "@/lib/text";
import { env } from "@/lib/env";
import { matchRule } from "./matcher";
import type { EventType } from "./matcher";
import { selectResponse, buildInteractiveContent } from "./response";
import type { MessageContent } from "@/lib/platforms/base";
import { sanitizeForLog } from "@/lib/api/safe-log";

/** Upper bound on active auto-reply rules a workspace may have — enforced at create (a clean 422)
 *  and as a defensive `limit` on the per-message executor fetch, so neither the sanctioned API nor an
 *  out-of-band writer can make the hot match-path unbounded (a tenant self-DoS ceiling).
 *  Far above any realistic configuration (the dashboard lists at most 200). */
export const MAX_ACTIVE_RULES = 1000;

/** The transaction handle passed to db.transaction's callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** A deferred unit of DB work — runs inside the fire transaction (enqueue or park). */
type CommitFn = (tx: DbTx) => Promise<void>;

/**
 * The terminal result of evaluating an event:
 * - `fired`      — a rule matched and its reply/approval was queued (`ruleId` set);
 * - `no_match`   — no rule fired; the event is now terminally claimed (so a redelivery,
 *                  even after a rule is added, won't reply late) — flag for a human;
 * - `already`    — the event was already handled (a prior delivery or a concurrent one);
 *                  the caller must NOT change conversation state for it.
 */
export type EvaluateOutcome = { outcome: "fired" | "no_match" | "already"; ruleId: string | null };

/** Thrown inside the fire transaction to roll back a non-firing outcome (skip / already). */
class NotFired extends Error {
  constructor(public reason: "already" | "skip") {
    super(reason);
  }
}

/** Same bound the write-side enforces on operator reply text (rules/route.ts). A rephrase completion
 *  bypasses that bound, so clamp the resolved text to it before it can reach an outbound job. */
const MAX_OUTBOUND_TEXT = 2000;

/** Defence-in-depth on LLM output: strip C0 control chars (keep tab/newline/CR) and bound the length
 *  to the write-side max, so an overlong or control-char-laden rephrase completion can't slip past
 *  the operator-text bounds and dead-letter a send. Operator base text is already bounded on
 *  write, so this only ever trims a misbehaving model. */
function clampOutboundText(text: string): string {
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return truncateCodePoints(stripped, MAX_OUTBOUND_TEXT);
}

/**
 * Resolve a rule's reply text: pick the base (single or random from a pool),
 * then optionally rephrase it through the LLM. Shared by the live send path
 * and the approval-park path so both produce identical wording.
 */
async function resolveDmText(
  workspaceId: string,
  responseType: string,
  responseConfig: Record<string, unknown>,
): Promise<string | null> {
  const { baseText, aiEnabled } = selectResponse(responseType, responseConfig);
  if (aiEnabled && baseText) {
    // Per-workspace LLM budget: an ai_rephrase rule on a broad trigger fires one paid call per
    // inbound across ALL contacts (the per-(rule,contact) cooldown/cap don't bound breadth), so an
    // inbound flood could run up an unbounded OpenAI bill. Over the rolling-24h cap, fail soft to the
    // operator's base text — the same safe fallback rephrase() already returns on error.
    const { allowed } = await rateLimit(`rl:llm:${workspaceId}`, env.AI_REPHRASE_DAILY_LIMIT, 86_400);
    if (!allowed) return baseText;
    const rephrased = await rephrase(baseText, {
      customPrompt: responseConfig.custom_prompt as string | undefined,
      tone: responseConfig.tone as string | undefined,
    });
    return clampOutboundText(rephrased);
  }
  return baseText;
}

/**
 * Resolve the full DM content (text + interactive add-ons) a rule would send.
 * Returns null when there is no text to send. Used to park an approvable,
 * ready-to-send message so the human approves exactly what goes out.
 */
export async function resolveReplyContent(
  workspaceId: string,
  responseType: string,
  responseConfig: Record<string, unknown>,
): Promise<MessageContent | null> {
  const text = await resolveDmText(workspaceId, responseType, responseConfig);
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
  /**
   * Stable identity for an event that has no natural ingest-dedup row of its own
   * (e.g. a reaction). When set, the fire is deduped on it in-transaction and the
   * outbound jobs get a deterministic idempotency key derived from it, so an
   * at-least-once redelivery cannot fire the rule (or send the reply) twice.
   */
  eventKey?: string;
}

/**
 * Evaluate all active rules for a workspace/channel and fire the first match.
 * Rules are sorted by priority (DESC) then created_at (ASC).
 * Returns the matched rule id, or null if no rule fired.
 */
export async function evaluateRules(
  input: EvaluateRulesInput
): Promise<EvaluateOutcome> {
  const { workspaceId, channelId, conversationId, contactId, recipientPlatformId, text, eventType, postId, commentId, quickReplyPayload, postbackPayload, isStoryReply, isStoryMention, isReaction, reactionType, eventKey } = input;

  const rules = await db.query.autoReplyRules.findMany({
    where: and(
      eq(autoReplyRules.workspace_id, workspaceId),
      eq(autoReplyRules.is_active, true),
      or(eq(autoReplyRules.channel_id, channelId), isNull(autoReplyRules.channel_id)),
    ),
    // `id` is the final, stable tiebreak so two same-priority rules created in the same millisecond
    // fire in a deterministic, run-to-run consistent order.
    orderBy: [desc(autoReplyRules.priority), asc(autoReplyRules.created_at), asc(autoReplyRules.id)],
    limit: MAX_ACTIVE_RULES,
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

  // Eligibility precheck (non-mutating): if this event was already handled, do nothing —
  // and never plan a reply (LLM rephrase) for it. The in-transaction claim below is the
  // authority; this just avoids the work on a redelivery.
  if (eventKey && (await isEventProcessed(eventKey))) return { outcome: "already", ruleId: null };

  // Consent gate: an unsubscribed contact gets NO automated reply — no rule, no comment→DM,
  // no follow-gate (which is enqueued from here). This runs before any rule is planned, so no
  // paid AI is spent on an opted-out contact. Operator manual replies are exempt: they
  // go through POST /conversations/:id/messages, not this path. The event is terminally claimed
  // as a no-match so a redelivery can't reply late, and the conversation is flagged for a human.
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, contactId),
    columns: { is_subscribed: true },
  });
  // A missing contact (erased mid-flight) is treated as "do not send", matching the sequence
  // worker — never fire to a contact we can no longer see.
  if (!contact?.is_subscribed) {
    if (eventKey) {
      const claimed = await claimEventOnce(eventKey);
      return { outcome: claimed ? "no_match" : "already", ruleId: null };
    }
    return { outcome: "no_match", ruleId: null };
  }

  // Batch the cooldown + send-count prechecks for ALL candidate rules into two queries up front,
  // instead of two queries per rule inside the loop (2N on the hot inbound path). The
  // in-transaction acquire below stays the concurrency authority — this is only an advisory peek.
  const { coolingDown, sendCounts } = await loadRuleLimits(rules.map((r) => r.id), contactId);

  for (const rule of rules) {
    const candidate = {
      ...rule,
      trigger_config: rule.trigger_config as Record<string, unknown>,
      response_config: rule.response_config as Record<string, unknown>,
      actions: rule.actions as unknown[],
    };

    // Guard the match itself: a single malformed rule (e.g. an out-of-band keyword row
    // missing `value`) must not throw and abort the whole loop — which, since rules iterate priority
    // DESC, would decapitate auto-reply for every message in the workspace. Log and skip to the next.
    let matched: boolean;
    try {
      matched = matchRule(candidate, { text, eventType, postId, quickReplyPayload, postbackPayload, isStoryReply, isStoryMention, isReaction, reactionType });
    } catch (err) {
      console.error(`[executor] rule ${candidate.id} match threw — skipping: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      continue;
    }
    if (!matched) continue;

    // `sequence` has no implemented effect yet, so it must not consume the event/limits or
    // block a lower-priority rule that could actually answer — fall through. The
    // write API also rejects creating new `sequence` rules.
    if (rule.response_type === "sequence") continue;

    // Eligibility precheck (non-mutating): skip planning the reply for a rule that is
    // cooling down or at its cap, so it neither calls the AI nor blocks fallthrough to a
    // lower-priority rule that should answer. The transactional acquire below stays the
    // concurrency authority (a peek can race), but it only runs for plausibly-firing rules.
    if (rule.cooldown_seconds > 0 && coolingDown.has(rule.id)) continue;
    if (rule.max_sends_per_contact != null && (sendCounts.get(rule.id) ?? 0) >= rule.max_sends_per_contact) continue;

    // Resolve everything that can fail on the network (LLM rephrase) BEFORE we touch
    // any durable state. A failure here spends no cooldown/send-count and writes no
    // claim, so the event simply retries.
    const keyBase = eventKey ? `${eventKey}:${rule.id}` : null;
    const commit: CommitFn = rule.requires_approval
      ? await planApproval({ rule: candidate, workspaceId, channelId, conversationId, contactId, recipientPlatformId })
      : await planResponse({ rule: candidate, workspaceId, channelId, conversationId, contactId, recipientPlatformId, commentId, keyBase });

    // Commit the rule's side effects as one unit: the event claim, the cooldown and
    // send-count mutations, and the outbound enqueue (or the parked approval) all
    // commit together or roll back together. So a failed/rolled-back fire never leaves
    // a spent limit or a stuck claim that would block the retry.
    //
    // Only a *fire* commits. A skip (cooldown/cap) or an already-handled event must roll
    // back everything the transaction touched — including the event claim and any cooldown
    // acquired before the cap check — otherwise a rule that didn't send would claim the
    // event (suppressing the next rule and the retry). Returning a value commits, so we
    // force the rollback by throwing a sentinel and reading it back out.
    let outcome: "already" | "skip" | "fired" = "fired";
    try {
      await db.transaction(async (tx) => {
        // Event-level dedup: a redelivery of an already-fired event finds the claim.
        if (eventKey && !(await claimEventOnce(eventKey, tx))) throw new NotFired("already");
        // Limits are spent on an actual send. An approval only PARKS a proposal — its
        // cooldown / send-count are charged when it is approved (so a reject/abandon costs
        // nothing and doesn't block the next event); parking just claims + stores it.
        if (!rule.requires_approval) {
          // Cooldown: atomic acquire prevents concurrent events from firing the same rule.
          if (!(await acquireCooldown(rule.id, contactId, rule.cooldown_seconds, tx))) throw new NotFired("skip");
          // Per-rule lifetime send limit: atomic increment-if-under-cap.
          if (
            rule.max_sends_per_contact != null &&
            !(await incrementSendCount(rule.id, contactId, rule.max_sends_per_contact, tx))
          ) {
            throw new NotFired("skip");
          }
        }
        await commit(tx);
      });
    } catch (e) {
      if (!(e instanceof NotFired)) throw e; // a real failure → rolled back; let the job retry
      outcome = e.reason;
    }

    if (outcome === "already") return { outcome: "already", ruleId: null }; // already handled
    if (outcome === "fired") return { outcome: "fired", ruleId: rule.id };
    // "skip": this rule is cooling down / at cap (or lost the race) — try the next one.
  }

  // No rule fired. Terminally mark the event as processed so a redelivery — even after a
  // new rule is added, or after the conversation is unpaused — does not produce a late
  // reply to an old event. A lost claim race means a concurrent delivery already handled it.
  if (eventKey) {
    const claimed = await claimEventOnce(eventKey);
    return { outcome: claimed ? "no_match" : "already", ruleId: null };
  }
  return { outcome: "no_match", ruleId: null };
}

/**
 * Manual approval: park a ready-to-send message for human review instead of
 * auto-sending. The content (incl. LLM rephrase) is resolved up front so the
 * approver acts on the exact text/buttons that will go out; the returned fn
 * inserts the parked row inside the fire transaction. (DM path; comment/follow-gate
 * approval is out of scope for now.)
 */
async function planApproval(input: {
  rule: { id: string; response_type: string; response_config: Record<string, unknown> };
  workspaceId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
}): Promise<CommitFn> {
  const { rule, workspaceId, channelId, conversationId, contactId, recipientPlatformId } = input;
  const content = await resolveReplyContent(workspaceId, rule.response_type, rule.response_config);
  return async (tx) => {
    await tx.insert(pendingApprovals).values({
      workspace_id: workspaceId,
      rule_id: rule.id,
      conversation_id: conversationId,
      contact_id: contactId,
      channel_id: channelId,
      recipient_platform_id: recipientPlatformId,
      proposed_content: JSON.parse(JSON.stringify({ content })),
    });
  };
}

interface PlanResponseInput {
  rule: {
    id: string;
    response_type: string;
    response_config: Record<string, unknown>;
    actions: unknown[];
  };
  workspaceId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
  commentId?: string;
  /** `${eventKey}:${ruleId}` when the event has a stable identity, else null. */
  keyBase: string | null;
}

/** Build outbound content from a follow-gate branch config ({ text, quick_replies?, buttons? }). */
function gatedContent(branch: unknown) {
  const cfg = (branch ?? {}) as Record<string, unknown>;
  return { text: cfg.text as string | undefined, ...buildInteractiveContent(cfg) };
}

/**
 * Resolve a rule's response (incl. LLM rephrase) and return a function that enqueues
 * the outbound job(s) inside the fire transaction. Resolving here — before the
 * transaction — keeps the network call out of the lock window; if it throws, no limit
 * is spent. When `keyBase` is set, each job carries a deterministic idempotency key so
 * a redelivery cannot send a duplicate even if it is re-evaluated.
 */
async function planResponse(input: PlanResponseInput): Promise<CommitFn> {
  const { rule, workspaceId, channelId, conversationId, contactId, recipientPlatformId, commentId, keyBase } = input;
  // Deterministic per-job key when we have an event identity; a fresh uuid otherwise.
  const idemKey = (discriminator: string) => (keyBase ? `${keyBase}:${discriminator}` : randomUUID());
  // Dedup the queued job too when the key is deterministic (extra guard on top of the
  // event claim); leave it unset for uuid keys to preserve prior behaviour.
  const jobKeyFor = (k: string) => (keyBase ? k : undefined);

  // Follow-gate: defer to a worker that re-checks follow status live, then
  // sends the appropriate branch or a re-prompt. Stateless — driven by each tap.
  if (rule.response_type === "follow_gate") {
    const key = idemKey("gate");
    return async (tx) => {
      await addJobTx(tx, "follow-gate", {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        followed: gatedContent(rule.response_config.followed),
        notFollowed: gatedContent(rule.response_config.not_followed),
        sentByRuleId: rule.id,
        idempotencyKey: key,
      }, { jobKey: jobKeyFor(key) });
    };
  }

  const replyMode = (rule.response_config.reply_mode as string) ?? "dm";

  // Resolve the text to send (single or random pick, optionally LLM-rephrased).
  const dmText = await resolveDmText(workspaceId, rule.response_type, rule.response_config);

  // Public comment reply (reply_mode: "comment" or "both")
  const commentReplyText = (rule.response_config.comment_reply_text as string) ?? dmText;
  const sendComment = (replyMode === "comment" || replyMode === "both") && !!commentId && !!commentReplyText;

  // Interactive add-ons (quick replies / buttons) attach to the DM body.
  const interactive = buildInteractiveContent(rule.response_config);
  const hasInteractive = interactive.quick_replies !== undefined || interactive.buttons !== undefined;

  // DM: send when reply_mode=dm, reply_mode=both, or fallback when comment couldn't go out.
  const shouldDM =
    (replyMode === "dm" || replyMode === "both" || (replyMode === "comment" && !sendComment)) && !!dmText;

  return async (tx) => {
    if (sendComment) {
      const key = idemKey("comment");
      await addJobTx(tx, "outgoing-comment", {
        channelId,
        contactId,
        commentId,
        text: commentReplyText!,
        sentByRuleId: rule.id,
        idempotencyKey: key,
      }, { jobKey: jobKeyFor(key) });
    }

    if (shouldDM) {
      if (commentId) {
        // Comment-triggered DM: addressed by comment_id (works first-touch, no PSID needed).
        const key = idemKey("dm");
        await addJobTx(tx, "outgoing-private-reply", {
          channelId,
          conversationId,
          contactId,
          commentId,
          text: dmText!,
          ...(hasInteractive ? { content: { text: dmText!, ...interactive } } : {}),
          sentByRuleId: rule.id,
          idempotencyKey: key,
        }, { jobKey: jobKeyFor(key) });
      } else {
        const key = idemKey("dm");
        await addJobTx(tx, "outgoing-message", {
          channelId,
          conversationId,
          contactId,
          recipientPlatformId,
          content: { text: dmText!, ...interactive },
          sentByRuleId: rule.id,
          idempotencyKey: key,
        }, { jobKey: jobKeyFor(key) });
      }
    }
  };
}
