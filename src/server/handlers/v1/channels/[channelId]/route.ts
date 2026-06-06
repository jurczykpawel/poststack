import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/channels/:channelId
export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, workspace_id: auth.workspaceId },
    select: {
      id: true,
      platform: true,
      platform_id: true,
      display_name: true,
      username: true,
      profile_picture: true,
      webhook_secret: true,
      status: true,
      last_error: true,
      last_health_at: true,
      created_at: true,
    },
  });

  if (!channel) return ApiErrors.notFound();
  return ok({ ...channel, is_active: channel.status === "active" });
}

const patchSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  // Manual status changes only — needs_reauth is set by the system.
  status: z.enum(["active", "paused", "disabled"]).optional(),
  // Backward-compatible boolean alias (true → active, false → disabled).
  is_active: z.boolean().optional(),
});

// PATCH /api/v1/channels/:channelId — update name or toggle active
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.channel.findFirst({
    where: { id: channelId, workspace_id: auth.workspaceId },
  });
  if (!existing) return ApiErrors.notFound();

  const data: { display_name?: string; status?: "active" | "paused" | "disabled" } = {};
  if (parsed.data.display_name !== undefined) data.display_name = parsed.data.display_name;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  else if (parsed.data.is_active !== undefined) data.status = parsed.data.is_active ? "active" : "disabled";

  const updated = await prisma.channel.update({
    where: { id: channelId },
    data,
    select: {
      id: true,
      platform: true,
      platform_id: true,
      display_name: true,
      username: true,
      profile_picture: true,
      status: true,
      last_error: true,
      last_health_at: true,
      created_at: true,
    },
  });

  return ok({ ...updated, is_active: updated.status === "active" });
}

// DELETE /api/v1/channels/:channelId — disconnect channel
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const result = await prisma.channel.deleteMany({
    where: { id: channelId, workspace_id: auth.workspaceId },
  });
  if (result.count === 0) return ApiErrors.notFound();

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelDisconnected,
    targetType: "channel",
    targetId: channelId,
  });

  return noContent();
}
