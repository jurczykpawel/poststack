import { and, eq, asc, desc, count } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoReplyRules, channels, sequences } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { MAX_ACTIVE_RULES } from "@/lib/rules/executor";
import { firstUnlicensedRuleFeature } from "@/lib/rules/feature-gate";
import { proMessage } from "@/lib/license/features";
import { env } from "@/lib/env";
import { z } from "zod";

export const runtime = "nodejs";

const keywordSchema = z.object({
  // Bounded: the value is matched on every inbound message. Trim BEFORE the length check
  //: the matcher trims the keyword, so a whitespace-only value would collapse to "" and
  // make contains/starts_with match every message — a silent catch-all. Reject it at write instead.
  value: z.string().trim().min(1).max(500),
  match_type: z.enum(["exact", "contains", "starts_with"]),
});

const triggerConfigSchema = z
  .object({
    keywords: z.array(keywordSchema).min(1).max(100).optional(),
    post_id: z.string().min(1).max(255).optional(), // comment_keyword: scope to one post/media
    payload: z.string().min(1).max(255).optional(), // postback
    reactions: z.array(z.string().min(1).max(50)).max(20).optional(), // reaction: filter by reaction type (empty = any)
  })
  .strict();

// Interactive add-ons. Limits are Meta's structural maxima (platform-agnostic);
// per-platform rendering quirks (e.g. IG ignores quick-reply image_url) are
// handled at send time so channel-agnostic rules stay valid for both networks.
const quickReplySchema = z
  .object({
    content_type: z.enum(["text", "user_email", "user_phone_number"]).default("text"),
    title: z.string().min(1).max(20).optional(), // Meta truncates titles >20 chars
    payload: z.string().max(1000).optional(),
    image_url: z.string().url().optional(),       // Messenger only
  })
  .strict()
  .superRefine((qr, ctx) => {
    if (qr.content_type === "text" && !qr.title) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "text quick reply requires a title" });
    }
  });

const buttonSchema = z
  .object({
    title: z.string().min(1).max(20),
    payload: z.string().max(1000).optional(), // postback button
    // Meta requires https for web_url buttons; .url() alone would accept javascript:/http:/data:,
    // which Meta rejects at send → the reply dead-letters on every trigger.
    url: z.string().url().refine((u) => /^https:\/\//i.test(u), "button URL must use https://").optional(),
  })
  .strict()
  .refine((b) => (b.url ? 1 : 0) + (b.payload ? 1 : 0) === 1, {
    message: "button must have exactly one of url or payload",
  });

// One branch of a follow-gate response (text + optional interactive add-ons).
const gatedMessageSchema = z
  .object({
    text: z.string().min(1).max(2000),
    quick_replies: z.array(quickReplySchema).max(13).optional(),
    buttons: z.array(buttonSchema).min(1).max(3).optional(),
  })
  .strict();

const responseConfigSchema = z
  .object({
    text: z.string().min(1).max(2000).optional(),            // text / ai_rephrase base
    messages: z.array(z.string().min(1).max(2000)).min(1).max(50).optional(),  // random_text pool
    tone: z.string().max(100).optional(),                    // ai_rephrase
    custom_prompt: z.string().max(2000).optional(),          // ai_rephrase
    ai_rephrase: z.boolean().optional(),                     // post-process any source through the LLM
    reply_mode: z.enum(["dm", "comment", "both"]).optional(),
    comment_reply_text: z.string().min(1).max(2000).optional(),
    // Anti-spam rotation pool for the public comment reply (analog of `messages` for DM): a
    // non-empty pool is picked from uniformly so Meta doesn't see identical repeated comments.
    // Either this or `comment_reply_text` (or the DM-text fallback) satisfies reply_mode comment/both.
    comment_reply_texts: z.array(z.string().min(1).max(2000)).max(50).optional(),
    quick_replies: z.array(quickReplySchema).max(13).optional(),
    buttons: z.array(buttonSchema).min(1).max(3).optional(),
    followed: gatedMessageSchema.optional(),      // follow_gate: sent when the user follows
    not_followed: gatedMessageSchema.optional(),  // follow_gate: sent when they do not (re-prompt)
    sequence_id: z.string().uuid().optional(),    // sequence: the drip the trigger enrolls the contact into
  })
  .strict();

export const createRuleSchema = z
  .object({
    name: z.string().min(1).max(100),
    channel_id: z.string().uuid().optional().nullable(),
    priority: z.number().int().min(0).max(999).default(0),
    trigger_type: z.enum([
      "keyword",
      "comment_keyword",
      "postback",
      "welcome",
      "default",
      "story_reply",
      "story_mention",
      "reaction",
    ]),
    trigger_config: triggerConfigSchema,
    // `sequence` enrolls the matched contact into a drip (SEQTRIGGER1); it requires
    // `response_config.sequence_id` (validated below) to point at an active sequence in the workspace.
    response_type: z.enum(["text", "random_text", "ai_rephrase", "none", "follow_gate", "sequence"]),
    response_config: responseConfigSchema,
    // Bounded at a sane 1-year ceiling, well under Postgres's timestamp range: an extreme value
    // pushes the cooldown's `now() + N seconds` past Postgres's max timestamp → "timestamp out of
    // range" when the rule fires, dead-lettering that message's job.
    cooldown_seconds: z.number().int().min(0).max(31_536_000).default(0),
    // null = no cap; a positive integer caps lifetime auto-sends per contact.
    max_sends_per_contact: z.number().int().min(1).max(1_000_000).nullable().optional(),
    requires_approval: z.boolean().default(false), // hold for human review before sending
  })
  .superRefine((data, ctx) => {
    const t = data.trigger_config;
    const r = data.response_config;
    const hasKeywords = (t.keywords?.length ?? 0) > 0;

    if (data.trigger_type === "keyword" && !hasKeywords) {
      ctx.addIssue({ code: "custom", path: ["trigger_config", "keywords"], message: "keyword trigger requires keywords" });
    }
    if (data.trigger_type === "comment_keyword" && !hasKeywords && !t.post_id) {
      ctx.addIssue({ code: "custom", path: ["trigger_config"], message: "comment_keyword requires keywords or post_id" });
    }
    if (data.trigger_type === "postback" && !t.payload) {
      ctx.addIssue({ code: "custom", path: ["trigger_config", "payload"], message: "postback trigger requires payload" });
    }
    // A `text`/`ai_rephrase` rule normally needs `text`. Exception: a comment-only reply
    // (reply_mode=comment) is satisfied by a public-comment source instead — a single
    // comment_reply_text or a comment_reply_texts pool — so `text` isn't required then.
    const hasCommentSource = !!r.comment_reply_text || (r.comment_reply_texts?.length ?? 0) > 0;
    const commentOnlySatisfies = data.response_type === "text" && r.reply_mode === "comment" && hasCommentSource;
    if ((data.response_type === "text" || data.response_type === "ai_rephrase") && !r.text && !commentOnlySatisfies) {
      ctx.addIssue({ code: "custom", path: ["response_config", "text"], message: `${data.response_type} requires text` });
    }
    if (data.response_type === "random_text" && (r.messages?.length ?? 0) === 0) {
      ctx.addIssue({ code: "custom", path: ["response_config", "messages"], message: "random_text requires messages" });
    }
    if (data.response_type === "sequence" && !r.sequence_id) {
      ctx.addIssue({ code: "custom", path: ["response_config", "sequence_id"], message: "sequence response requires sequence_id" });
    }
    if (data.response_type === "follow_gate") {
      if (!r.followed || !r.not_followed) {
        ctx.addIssue({ code: "custom", path: ["response_config"], message: "follow_gate requires followed and not_followed messages" });
      }
      // Close the follow-to-unlock loop: the re-prompt (not_followed) produces a postback
      // when tapped, so the gate must live on a postback trigger AND the re-prompt must carry a
      // button whose payload matches the trigger payload — otherwise tapping "claim" generates a
      // postback nobody handles and the loop is permanently broken.
      if (data.trigger_type !== "postback") {
        ctx.addIssue({ code: "custom", path: ["trigger_type"], message: "follow_gate requires a postback trigger so the re-prompt button can re-run the follow check" });
      } else {
        // Compare payloads case-insensitively — the runtime postback matcher lowercases both sides,
        // so "CLAIM" + "claim" DO match at runtime and must not be rejected here.
        const triggerPayload = t.payload?.toLowerCase();
        const buttons = r.not_followed?.buttons ?? [];
        if (triggerPayload && !buttons.some((b) => b.payload?.toLowerCase() === triggerPayload)) {
          ctx.addIssue({ code: "custom", path: ["response_config", "not_followed"], message: "follow_gate re-prompt must include a button whose payload matches the trigger payload (to re-run the gate)" });
        }
      }
    }
    // Approval gate parks a single PSID-addressed DM, so it only applies to
    // text-family responses (the approval parks resolved text/buttons; follow_gate/sequence aren't
    // held). Comment triggers and reply_mode comment/both ARE supported: the approval parks the
    // public comment AND the DM, and Approve sends both (the comment-triggered DM goes out as a
    // private reply addressed by comment_id).
    if (data.requires_approval) {
      if (!["text", "random_text", "ai_rephrase"].includes(data.response_type)) {
        ctx.addIssue({ code: "custom", path: ["requires_approval"], message: "requires_approval is only supported for text, random_text or ai_rephrase responses" });
      }
    }
  });

/**
 * SEQTRIGGER1: validate that a `sequence`-response rule points at a sequence that exists in this
 * workspace and is ACTIVE (a draft/archived/missing sequence would silently never enroll). Returns
 * a 422 Response on failure, or null when the rule isn't a sequence rule / the sequence is valid.
 * Shared by the create (POST) and update (PATCH) paths so both enforce the same invariant.
 */
export async function invalidSequenceResponse(
  workspaceId: string,
  responseType: string,
  responseConfig: Record<string, unknown>,
): Promise<Response | null> {
  if (responseType !== "sequence") return null;
  const sequenceId = responseConfig.sequence_id;
  if (typeof sequenceId !== "string") {
    return ApiErrors.validationError({ "response_config.sequence_id": ["sequence response requires sequence_id"] });
  }
  const seq = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, workspaceId)),
    columns: { id: true, status: true },
  });
  if (!seq) return ApiErrors.validationError({ "response_config.sequence_id": ["Sequence not found in this workspace"] });
  if (seq.status !== "active") {
    return ApiErrors.validationError({ "response_config.sequence_id": ["Sequence must be active to enroll contacts — activate it first"] });
  }
  return null;
}

// GET /api/v1/rules
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "rules:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const rules = await db.query.autoReplyRules.findMany({
    where: eq(autoReplyRules.workspace_id, auth.workspaceId),
    orderBy: [desc(autoReplyRules.priority), asc(autoReplyRules.created_at)],
    limit: 200,
    columns: {
      id: true,
      name: true,
      channel_id: true,
      is_active: true,
      priority: true,
      trigger_type: true,
      trigger_config: true,
      response_type: true,
      response_config: true,
      cooldown_seconds: true,
      max_sends_per_contact: true,
      requires_approval: true,
      created_at: true,
    },
  });

  return ok(rules);
}

// POST /api/v1/rules
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "rules:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  // Verify channel belongs to this workspace if provided
  if (parsed.data.channel_id) {
    const channel = await db.query.channels.findFirst({
      where: and(eq(channels.id, parsed.data.channel_id), eq(channels.workspace_id, auth.workspaceId)),
      columns: { id: true },
    });
    if (!channel) return ApiErrors.notFound("Channel");
  }

  // SEQTRIGGER1: a sequence-response rule must target an active sequence in this workspace.
  const badSequence = await invalidSequenceResponse(auth.workspaceId, parsed.data.response_type, parsed.data.response_config);
  if (badSequence) return badSequence;

  // Gate PRO features a rule would use (personalization, AI rephrase, follow-gate, interactive)
  // at authoring time on an unlicensed instance.
  const missingFeature = await firstUnlicensedRuleFeature({
    responseType: parsed.data.response_type,
    responseConfig: parsed.data.response_config,
    triggerType: parsed.data.trigger_type,
  });
  if (missingFeature) {
    return ApiErrors.proRequired(missingFeature, env.LICENSE_UPGRADE_URL, proMessage(missingFeature));
  }

  // Cap active rules per workspace so the per-message match path stays bounded — a tenant can't
  // (accidentally or maliciously) accumulate enough rules to slow its own processing.
  const [{ n: activeRuleCount }] = await db
    .select({ n: count() })
    .from(autoReplyRules)
    .where(and(eq(autoReplyRules.workspace_id, auth.workspaceId), eq(autoReplyRules.is_active, true)));
  if (activeRuleCount >= MAX_ACTIVE_RULES) {
    return ApiErrors.validationError({ _errors: [`Workspace has reached the maximum of ${MAX_ACTIVE_RULES} active rules`] });
  }

  const [rule] = await db
    .insert(autoReplyRules)
    .values({
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      channel_id: parsed.data.channel_id ?? null,
      priority: parsed.data.priority,
      trigger_type: parsed.data.trigger_type,
      trigger_config: parsed.data.trigger_config,
      response_type: parsed.data.response_type,
      response_config: parsed.data.response_config,
      cooldown_seconds: parsed.data.cooldown_seconds,
      max_sends_per_contact: parsed.data.max_sends_per_contact ?? null,
      requires_approval: parsed.data.requires_approval,
    })
    .returning();

  return created(rule);
}
