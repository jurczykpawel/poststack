import { and, eq, asc, desc } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoReplyRules, channels } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const keywordSchema = z.object({
  value: z.string().min(1),
  match_type: z.enum(["exact", "contains", "starts_with"]),
});

const triggerConfigSchema = z
  .object({
    keywords: z.array(keywordSchema).min(1).optional(),
    post_id: z.string().min(1).max(255).optional(), // comment_keyword: scope to one post/media
    payload: z.string().min(1).max(255).optional(), // postback
    reactions: z.array(z.string().min(1)).optional(), // reaction: filter by reaction type (empty = any)
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
    url: z.string().url().optional(),         // web_url button
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
    messages: z.array(z.string().min(1)).min(1).optional(),  // random_text pool
    tone: z.string().max(100).optional(),                    // ai_rephrase
    custom_prompt: z.string().max(2000).optional(),          // ai_rephrase
    ai_rephrase: z.boolean().optional(),                     // post-process any source through the LLM
    reply_mode: z.enum(["dm", "comment", "both"]).optional(),
    comment_reply_text: z.string().min(1).max(2000).optional(),
    quick_replies: z.array(quickReplySchema).max(13).optional(),
    buttons: z.array(buttonSchema).min(1).max(3).optional(),
    followed: gatedMessageSchema.optional(),      // follow_gate: sent when the user follows
    not_followed: gatedMessageSchema.optional(),  // follow_gate: sent when they do not (re-prompt)
  })
  .strict();

const createRuleSchema = z
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
    response_type: z.enum(["text", "random_text", "ai_rephrase", "sequence", "none", "follow_gate"]),
    response_config: responseConfigSchema,
    cooldown_seconds: z.number().int().min(0).default(0),
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
    if ((data.response_type === "text" || data.response_type === "ai_rephrase") && !r.text) {
      ctx.addIssue({ code: "custom", path: ["response_config", "text"], message: `${data.response_type} requires text` });
    }
    if (data.response_type === "random_text" && (r.messages?.length ?? 0) === 0) {
      ctx.addIssue({ code: "custom", path: ["response_config", "messages"], message: "random_text requires messages" });
    }
    if (data.response_type === "follow_gate" && (!r.followed || !r.not_followed)) {
      ctx.addIssue({ code: "custom", path: ["response_config"], message: "follow_gate requires followed and not_followed messages" });
    }
    // Approval gate parks a single PSID-addressed DM, so it only applies to
    // DM-producing responses and not to comment triggers (whose first-touch DM
    // is addressed by comment_id, which the approval does not carry).
    if (data.requires_approval) {
      if (!["text", "random_text", "ai_rephrase"].includes(data.response_type)) {
        ctx.addIssue({ code: "custom", path: ["requires_approval"], message: "requires_approval is only supported for text, random_text or ai_rephrase responses" });
      }
      if (data.trigger_type === "comment_keyword") {
        ctx.addIssue({ code: "custom", path: ["requires_approval"], message: "requires_approval is not supported for comment triggers" });
      }
      if (r.reply_mode && r.reply_mode !== "dm") {
        ctx.addIssue({ code: "custom", path: ["response_config", "reply_mode"], message: "requires_approval only supports reply_mode dm" });
      }
    }
  });

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
      requires_approval: parsed.data.requires_approval,
    })
    .returning();

  return created(rule);
}
