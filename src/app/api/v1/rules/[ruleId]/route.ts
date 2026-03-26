import { authenticate, authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/rules/:ruleId
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const rule = await prisma.autoReplyRule.findFirst({
    where: { id: ruleId, workspace_id: auth.workspaceId },
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
      max_sends_per_contact: true,
      requires_approval: true,
      created_at: true,
      updated_at: true,
    },
  });
  if (!rule) return ApiErrors.notFound();
  return ok(rule);
}

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().min(0).max(999).optional(),
  trigger_type: z
    .enum(["keyword","comment_keyword","postback","welcome","default","story_reply","story_mention"])
    .optional(),
  trigger_config: z.record(z.unknown()).optional(),
  response_type: z.enum(["text","random_text","ai_rephrase","sequence","none"]).optional(),
  response_config: z.record(z.unknown()).optional(),
  cooldown_seconds: z.number().int().min(0).optional(),
});

// PATCH /api/v1/rules/:ruleId
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const existing = await prisma.autoReplyRule.findFirst({
    where: { id: ruleId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const { trigger_config, response_config, ...rest } = parsed.data;
  const updated = await prisma.autoReplyRule.update({
    where: { id: ruleId },
    data: {
      ...rest,
      ...(trigger_config !== undefined
        ? { trigger_config: trigger_config as Prisma.InputJsonValue }
        : {}),
      ...(response_config !== undefined
        ? { response_config: response_config as Prisma.InputJsonValue }
        : {}),
    },
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
  const result = await prisma.autoReplyRule.deleteMany({
    where: { id: ruleId, workspace_id: auth.workspaceId },
  });
  if (result.count === 0) return ApiErrors.notFound();
  return noContent();
}
