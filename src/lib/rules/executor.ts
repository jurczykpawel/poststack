import { randomUUID } from "crypto";
import { and, or, eq, isNull, desc, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { autoReplyRules, pendingApprovals, contacts, sequences } from "@/db/schema";
import { acquireCooldown, incrementSendCount, loadRuleLimits } from "./limits";
import { addJobTx } from "@/lib/queue/client";
import { claimEvent, isEventTerminal, type EventOutcomeLinks } from "@/lib/idempotency";
import { recordResponseMetric, type RecordedMetric } from "@/lib/metrics/capture";
import type { ConversationThreadType, Platform } from "@/db/schema";
import { rephrase } from "@/lib/ai/rephrase";
import { rateLimit } from "@/lib/api/rate-limit";
import { truncateCodePoints } from "@/lib/text";
import { env } from "@/lib/env";
import { applyTagsByName } from "@/lib/contacts/tags";
import { matchRule } from "./matcher";
import type { EventType } from "./matcher";
import { selectResponse, buildInteractiveContent, pickText } from "./response";
import type { MessageContent } from "@/lib/platforms/base";
import { getProvider } from "@/lib/platforms/registry";

/** Whether a platform can receive a DM reply (FB/IG yes; YouTube polls comments, has no DM). Drives
 *  the no-DM fallback: a rule fired on such a platform replies as a public comment, never a DM. */
function platformSupportsDM(platform: string): boolean {
  try {
    return getProvider(platform as Parameters<typeof getProvider>[0]).inboundCapabilities().includes("dm");
  } catch {
    return true; // unknown platform — don't suppress the DM
  }
}
import { sanitizeForLog } from "@/lib/api/safe-log";
import { hasFeature } from "@/lib/license/gate";
import { enrollContactInSequence } from "@/lib/sequences/enroll";
import { applyPersonalization, type PersonalizeContext } from "./personalization";
import type { ProposedContent } from "@/lib/approvals/draft";

/** Upper bound on active auto-reply rules a workspace may have — enforced at create (a clean 422)
 *  and as a defensive `limit` on the per-message executor fetch, so neither the sanctioned API nor an
 *  out-of-band writer can make the hot match-path unbounded (a tenant self-DoS ceiling).
 *  Far above any realistic configuration (the dashboard lists at most 200). */
export const MAX_ACTIVE_RULES = 1000;

/** The transaction handle passed to db.transaction's callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** A deferred unit of DB work — runs inside the fire transaction (enqueue or park). Receives the
 *  captured trigger stamp (TIMING2) so the FIRST outbound response can carry it; null when the
 *  event has no logged metric anchor (a direct worker invocation that skipped the edge log). */
type CommitFn = (tx: DbTx, stamp: RecordedMetric | null) => Promise<void>;

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
  /** The channel's platform — gates DM-only replies on platforms without DMs (e.g. YouTube). */
  platform: string;
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
  const { workspaceId, channelId, platform, conversationId, contactId, recipientPlatformId, text, eventType, postId, commentId, quickReplyPayload, postbackPayload, isStoryReply, isStoryMention, isReaction, reactionType, eventKey } = input;

  // TIMING3: a comment lives in a comment thread; a DM / reaction in a dm thread (mirrors how the
  // workers resolve the conversation thread_type), so the metric's thread_type is derivable here
  // without re-reading the conversation row.
  const threadType: ConversationThreadType = eventType === "comment" ? "comment" : "dm";
  // Write one response_metrics row for a terminal handling decision, on the SAME executor that took
  // the terminal claim (so it commits/rolls back atomically with it). Only when the event was logged
  // (has an eventKey) — a direct/test invocation with no edge row has no metric anchor.
  const writeMetric = (executor: Parameters<typeof recordResponseMetric>[0], status: "fired" | "no_match", viaSequence = false) =>
    eventKey
      ? recordResponseMetric(executor, {
          eventKey,
          workspaceId,
          channelId,
          platform: platform as Platform,
          threadType,
          status,
          viaSequence,
        })
      : Promise.resolve(null);

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

  // Outcome links recorded on the webhook_events row when we claim the event — the executor knows
  // the contact + conversation; the worker enriches message/comment/delivery ids after (1.4).
  const links: EventOutcomeLinks = { contact_id: contactId, conversation_id: conversationId };

  // Eligibility precheck (non-mutating): if this event was already handled, do nothing —
  // and never plan a reply (LLM rephrase) for it. The in-transaction claim below is the
  // authority; this just avoids the work on a redelivery.
  if (eventKey && (await isEventTerminal(eventKey))) return { outcome: "already", ruleId: null };

  // Consent gate: an unsubscribed contact gets NO automated reply — no rule, no comment→DM,
  // no follow-gate (which is enqueued from here). This runs before any rule is planned, so no
  // paid AI is spent on an opted-out contact. Operator manual replies are exempt: they
  // go through POST /conversations/:id/messages, not this path. The event is terminally claimed
  // as a no-match so a redelivery can't reply late, and the conversation is flagged for a human.
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, contactId),
    columns: { is_subscribed: true, display_name: true },
  });
  // A missing contact (erased mid-flight) is treated as "do not send", matching the sequence
  // worker — never fire to a contact we can no longer see.
  if (!contact?.is_subscribed) {
    if (eventKey) {
      const claimed = await claimEvent(eventKey, "no_match", links, db, { event_type: eventType });
      // Capture the metric only when THIS call won the claim (it set handled_at); a lost race means
      // a concurrent delivery already recorded the outcome, and the ON CONFLICT would no-op anyway.
      if (claimed) await writeMetric(db, "no_match");
      return { outcome: claimed ? "no_match" : "already", ruleId: null };
    }
    return { outcome: "no_match", ruleId: null };
  }

  // Personalization (PRO): resolved once per inbound (the license check is cached). When the
  // feature is off, placeholders are stripped safely downstream — never leaked literally.
  const personalize: PersonalizeContext = {
    displayName: contact.display_name ?? null,
    enabled: await hasFeature("personalization"),
  };

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
    let commit: CommitFn;
    // The fired response rides a sequence drip (the metric records via_sequence=true) only for a
    // `sequence` rule — every other response type is a direct reply.
    const viaSequence = rule.response_type === "sequence";
    if (rule.response_type === "sequence") {
      // SEQTRIGGER1: a `sequence` rule enrolls the contact into a drip on match. If the configured
      // sequence is missing/inactive (or the instance isn't licensed for sequences), we plan nothing
      // and fall through — the event isn't consumed and a lower-priority rule can still answer.
      const planned = await planSequenceEnrollment({ rule: candidate, workspaceId, channelId, contactId });
      if (!planned) continue;
      commit = planned;
    } else if (rule.requires_approval) {
      commit = await planApproval({ rule: candidate, workspaceId, channelId, platform, conversationId, contactId, recipientPlatformId, commentId, personalize });
    } else {
      commit = await planResponse({ rule: candidate, workspaceId, channelId, platform, conversationId, contactId, recipientPlatformId, commentId, keyBase, personalize });
    }

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
        if (eventKey && !(await claimEvent(eventKey, "fired", links, tx, { event_type: eventType }))) throw new NotFired("already");
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
        // TIMING3: capture the answered metric in the fire tx (after the claim set handled_at, so
        // handling_ms is exact), then hand its stamp to the commit so the FIRST outbound response
        // can carry it (TIMING2). A parked approval is not a sent response — its stamp is unused.
        const stamp = await writeMetric(tx, "fired", viaSequence);
        await commit(tx, stamp);
        // CRMTAG1: a fired rule may tag the contact (segment on keyword/comment/etc.). In the fire tx
        // so it commits/rolls back atomically with the send — a skipped/already-handled rule tags nothing.
        await applyTagsByName(tx, workspaceId, contactId, candidate.response_config.add_tags as string[] | undefined);
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
    const claimed = await claimEvent(eventKey, "no_match", links, db, { event_type: eventType });
    if (claimed) await writeMetric(db, "no_match");
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
  platform: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
  commentId?: string;
  personalize: PersonalizeContext;
}): Promise<CommitFn> {
  const { rule, workspaceId, channelId, platform, conversationId, contactId, recipientPlatformId, commentId, personalize } = input;
  const replyMode = (rule.response_config.reply_mode as string) ?? "dm";
  const canDM = platformSupportsDM(platform);

  // The DM body (text + interactive add-ons), personalized — exactly what Approve will send.
  const dmContent = await resolveReplyContent(workspaceId, rule.response_type, rule.response_config);
  if (dmContent?.text) dmContent.text = applyPersonalization(dmContent.text, personalize);

  // Public comment reply (reply_mode comment/both, or any no-DM platform) — mirrors planResponse so
  // a "both" rule held for approval parks the comment AND the DM, and Approve sends both.
  const pickedComment = pickText(
    rule.response_config.comment_reply_text as string | undefined,
    rule.response_config.comment_reply_texts as string[] | undefined,
  );
  const commentReplyText = (pickedComment != null ? applyPersonalization(pickedComment, personalize) : undefined) ?? dmContent?.text ?? undefined;
  const sendComment = (!canDM || replyMode === "comment" || replyMode === "both") && !!commentId && !!commentReplyText;
  const shouldDM = canDM && (replyMode === "dm" || replyMode === "both" || (replyMode === "comment" && !sendComment)) && !!dmContent?.text;

  const proposed: ProposedContent = {};
  if (shouldDM) proposed.content = dmContent;
  if (sendComment) proposed.comment = { text: commentReplyText!, commentId: commentId! };
  // Never park an empty proposal (e.g. an unresolvable config) — keep the DM body as a fallback.
  if (!proposed.content && !proposed.comment) proposed.content = dmContent;

  // The stamp is intentionally unused: a parked approval is not yet a sent response, so first-
  // response latency is only stamped when the approved message is actually enqueued downstream.
  return async (tx) => {
    await tx.insert(pendingApprovals).values({
      workspace_id: workspaceId,
      rule_id: rule.id,
      conversation_id: conversationId,
      contact_id: contactId,
      channel_id: channelId,
      recipient_platform_id: recipientPlatformId,
      proposed_content: JSON.parse(JSON.stringify(proposed)),
    });
  };
}

/**
 * SEQTRIGGER1: plan a drip-sequence enrollment for a `sequence`-response rule. Resolves and validates
 * the target sequence BEFORE the fire transaction (so a missing/inactive sequence spends no limits),
 * returning a CommitFn that enrolls the contact inside the transaction, or null to fall through.
 *
 * Returns null (don't consume the event) when:
 *  - the instance isn't licensed for `sequences` (a lapsed PRO rule degrades safely, like other
 *    PRO responses), or
 *  - `response_config.sequence_id` is absent/not a string, or
 *  - no ACTIVE sequence with that id exists in the workspace (deleted/archived/cross-workspace).
 *
 * The enroll itself is idempotent (unique (sequence, contact) → onConflictDoNothing), so a contact
 * already in the sequence is a no-op even though the rule still "fires" (claims the event / spends
 * its cooldown), which is the intended once-per-contact drip behaviour.
 */
async function planSequenceEnrollment(input: {
  rule: { id: string; response_config: Record<string, unknown> };
  workspaceId: string;
  channelId: string;
  contactId: string;
}): Promise<CommitFn | null> {
  if (!(await hasFeature("sequences"))) return null;
  const sequenceId = input.rule.response_config.sequence_id;
  if (typeof sequenceId !== "string" || !sequenceId) return null;
  const sequence = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, input.workspaceId), eq(sequences.status, "active")),
    columns: { id: true, steps: true },
  });
  if (!sequence) return null;
  return async (tx, stamp) => {
    // Carry the trigger stamp into the enrollment so the FIRST sequence message (a step-0 `message`)
    // is measurable; the enroll helper forwards it onto the step-0 job only.
    await enrollContactInSequence(tx, {
      sequence,
      contactId: input.contactId,
      channelId: input.channelId,
      trigger: stamp ? { eventId: stamp.triggerEventId, receivedAt: stamp.triggerReceivedAt } : undefined,
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
  platform: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
  commentId?: string;
  /** `${eventKey}:${ruleId}` when the event has a stable identity, else null. */
  keyBase: string | null;
  personalize: PersonalizeContext;
}

/** TIMING2: turn a captured metric stamp into the three optional first-response payload fields. A
 *  direct reply is the first (and only first) response to its trigger, so it is always measurable;
 *  an absent stamp (no logged event) yields an empty object that omits the fields entirely. */
function firstResponseStamp(stamp: RecordedMetric | null): { triggerEventId?: string; triggerReceivedAt?: string; measurable?: boolean } {
  if (!stamp) return {};
  return { triggerEventId: stamp.triggerEventId, triggerReceivedAt: stamp.triggerReceivedAt.toISOString(), measurable: true };
}

/** Build outbound content from a follow-gate branch config ({ text, quick_replies?, buttons? }). */
function gatedContent(branch: unknown, personalize: PersonalizeContext) {
  const cfg = (branch ?? {}) as Record<string, unknown>;
  const text = typeof cfg.text === "string" ? applyPersonalization(cfg.text, personalize) : (cfg.text as string | undefined);
  return { text, ...buildInteractiveContent(cfg) };
}

/**
 * Resolve a rule's response (incl. LLM rephrase) and return a function that enqueues
 * the outbound job(s) inside the fire transaction. Resolving here — before the
 * transaction — keeps the network call out of the lock window; if it throws, no limit
 * is spent. When `keyBase` is set, each job carries a deterministic idempotency key so
 * a redelivery cannot send a duplicate even if it is re-evaluated.
 */
async function planResponse(input: PlanResponseInput): Promise<CommitFn> {
  const { rule, workspaceId, channelId, platform, conversationId, contactId, recipientPlatformId, commentId, keyBase, personalize } = input;
  // Deterministic per-job key when we have an event identity; a fresh uuid otherwise.
  const idemKey = (discriminator: string) => (keyBase ? `${keyBase}:${discriminator}` : randomUUID());
  // Dedup the queued job too when the key is deterministic (extra guard on top of the
  // event claim); leave it unset for uuid keys to preserve prior behaviour.
  const jobKeyFor = (k: string) => (keyBase ? k : undefined);

  // Follow-gate: defer to a worker that re-checks follow status live, then
  // sends the appropriate branch or a re-prompt. Stateless — driven by each tap.
  if (rule.response_type === "follow_gate") {
    const key = idemKey("gate");
    return async (tx, stamp) => {
      await addJobTx(tx, "follow-gate", {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        followed: gatedContent(rule.response_config.followed, personalize),
        notFollowed: gatedContent(rule.response_config.not_followed, personalize),
        sentByRuleId: rule.id,
        idempotencyKey: key,
        ...firstResponseStamp(stamp),
      }, { jobKey: jobKeyFor(key) });
    };
  }

  const replyMode = (rule.response_config.reply_mode as string) ?? "dm";

  // Resolve the text to send (single or random pick, optionally LLM-rephrased), then personalize
  // (placeholders substituted when licensed, safely stripped otherwise).
  const rawDmText = await resolveDmText(workspaceId, rule.response_type, rule.response_config);
  const dmText = rawDmText !== null ? applyPersonalization(rawDmText, personalize) : null;

  // Public comment reply (reply_mode: "comment" or "both"). A non-empty pool rotates uniformly
  // (anti-spam); else the single text; else fall back to the (already personalized) DM text.
  const pickedComment = pickText(
    rule.response_config.comment_reply_text as string | undefined,
    rule.response_config.comment_reply_texts as string[] | undefined,
  );
  const commentReplyText =
    (pickedComment != null ? applyPersonalization(pickedComment, personalize) : undefined) ?? dmText;
  // On a platform without DMs (e.g. YouTube), every reply becomes a public comment — there is no DM
  // to send, and reply_mode=dm/both would otherwise enqueue a DM job that can only fail.
  const canDM = platformSupportsDM(platform);
  const sendComment = (!canDM || replyMode === "comment" || replyMode === "both") && !!commentId && !!commentReplyText;

  // Interactive add-ons (quick replies / buttons) attach to the DM body.
  const interactive = buildInteractiveContent(rule.response_config);
  const hasInteractive = interactive.quick_replies !== undefined || interactive.buttons !== undefined;

  // DM: send when reply_mode=dm, reply_mode=both, or fallback when comment couldn't go out — but
  // never on a no-DM platform (there the comment above is the whole reply).
  const shouldDM =
    canDM && (replyMode === "dm" || replyMode === "both" || (replyMode === "comment" && !sendComment)) && !!dmText;

  return async (tx, stamp) => {
    // A rule firing both a public comment AND a DM produces two responses to one trigger; both are
    // stamped measurable, and the first to reach `sent` wins first_response_ms (the `IS NULL` guard
    // makes the later one a no-op) — so the metric records the genuine first-response latency.
    const stampFields = firstResponseStamp(stamp);
    if (sendComment) {
      const key = idemKey("comment");
      await addJobTx(tx, "outgoing-comment", {
        channelId,
        contactId,
        commentId,
        text: commentReplyText!,
        sentByRuleId: rule.id,
        idempotencyKey: key,
        ...stampFields,
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
          ...stampFields,
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
          ...stampFields,
        }, { jobKey: jobKeyFor(key) });
      }
    }
  };
}
