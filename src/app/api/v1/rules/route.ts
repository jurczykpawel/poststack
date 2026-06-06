import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const keywordSchema = z.object({
  value: z.string().min(1),
  match_type: z.enum(["exact", "contains", "starts_with"]),
});

const triggerConfigSchema = z.union([
  z.object({ keywords: z.array(keywordSchema).min(1) }), // keyword / comment_keyword
  z.object({}), // welcome / default / story_reply / story_mention
]);

const responseConfigSchema = z.union([
  z.object({ text: z.string().min(1).max(2000) }),                                    // text
  z.object({ messages: z.array(z.string().min(1)).min(1) }),                           // random_text
  z.object({ text: z.string().min(1).max(2000), tone: z.string().max(100).optional() }), // ai_rephrase
  z.object({}),                                                                        // none / sequence
]);

const createRuleSchema = z.object({
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
  ]),
  trigger_config: triggerConfigSchema,
  response_type: z.enum(["text", "random_text", "ai_rephrase", "sequence", "none"]),
  response_config: responseConfigSchema,
  cooldown_seconds: z.number().int().min(0).default(0),
});

// GET /api/v1/rules
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "rules:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const rules = await prisma.autoReplyRule.findMany({
    where: { workspace_id: auth.workspaceId },
    orderBy: [{ priority: "desc" }, { created_at: "asc" }],
    take: 200,
    select: {
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
    const channel = await prisma.channel.findFirst({
      where: { id: parsed.data.channel_id, workspace_id: auth.workspaceId },
      select: { id: true },
    });
    if (!channel) return ApiErrors.notFound("Channel");
  }

  const rule = await prisma.autoReplyRule.create({
    data: {
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      channel_id: parsed.data.channel_id ?? null,
      priority: parsed.data.priority,
      trigger_type: parsed.data.trigger_type,
      trigger_config: parsed.data.trigger_config,
      response_type: parsed.data.response_type,
      response_config: parsed.data.response_config,
      cooldown_seconds: parsed.data.cooldown_seconds,
    },
  });

  return created(rule);
}
