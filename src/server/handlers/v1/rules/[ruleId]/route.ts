import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoReplyRules } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const RULE_COLUMNS = {
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
  updated_at: true,
} as const;

// GET /api/v1/rules/:ruleId
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const rule = await db.query.autoReplyRules.findFirst({
    where: and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)),
    columns: RULE_COLUMNS,
  });
  if (!rule) return ApiErrors.notFound();
  return ok(rule);
}

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().min(0).max(999).optional(),
  trigger_type: z
    .enum(["keyword", "comment_keyword", "postback", "welcome", "default", "story_reply", "story_mention", "reaction"])
    .optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
  response_type: z.enum(["text", "random_text", "ai_rephrase", "sequence", "none", "follow_gate"]).optional(),
  response_config: z.record(z.string(), z.unknown()).optional(),
  cooldown_seconds: z.number().int().min(0).optional(),
  requires_approval: z.boolean().optional(),
});

// PATCH /api/v1/rules/:ruleId
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const existing = await db.query.autoReplyRules.findFirst({
    where: and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const [updated] = await db
    .update(autoReplyRules)
    .set(parsed.data)
    .where(eq(autoReplyRules.id, ruleId))
    .returning({
      id: autoReplyRules.id,
      name: autoReplyRules.name,
      channel_id: autoReplyRules.channel_id,
      is_active: autoReplyRules.is_active,
      priority: autoReplyRules.priority,
      trigger_type: autoReplyRules.trigger_type,
      trigger_config: autoReplyRules.trigger_config,
      response_type: autoReplyRules.response_type,
      response_config: autoReplyRules.response_config,
      cooldown_seconds: autoReplyRules.cooldown_seconds,
      max_sends_per_contact: autoReplyRules.max_sends_per_contact,
      requires_approval: autoReplyRules.requires_approval,
      created_at: autoReplyRules.created_at,
      updated_at: autoReplyRules.updated_at,
    });

  return ok(updated);
}

// DELETE /api/v1/rules/:ruleId
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const result = await db
    .delete(autoReplyRules)
    .where(and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)));
  if ((result.rowCount ?? 0) === 0) return ApiErrors.notFound();
  return noContent();
}
