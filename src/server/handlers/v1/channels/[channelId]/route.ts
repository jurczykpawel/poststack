import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db, isUniqueViolation } from "@/lib/db";
import { channels } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

const DETAIL_COLUMNS = {
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
} as const;

// GET /api/v1/channels/:channelId
export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticateWithScope(request, "channels:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, channelId), eq(channels.workspace_id, auth.workspaceId)),
    // webhook_secret is machine-only (the app registers + verifies it); never in the API response.
    columns: DETAIL_COLUMNS,
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

  const existing = await db.query.channels.findFirst({
    where: and(eq(channels.id, channelId), eq(channels.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const data: { display_name?: string; status?: "active" | "paused" | "disabled" } = {};
  if (parsed.data.display_name !== undefined) data.display_name = parsed.data.display_name;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  else if (parsed.data.is_active !== undefined) data.status = parsed.data.is_active ? "active" : "disabled";

  let updated;
  try {
    [updated] = await db
      .update(channels)
      .set(data)
      .where(eq(channels.id, channelId))
      .returning({
        id: channels.id,
        platform: channels.platform,
        platform_id: channels.platform_id,
        display_name: channels.display_name,
        username: channels.username,
        profile_picture: channels.profile_picture,
        status: channels.status,
        last_error: channels.last_error,
        last_health_at: channels.last_health_at,
        created_at: channels.created_at,
      });
  } catch (err) {
    // Reactivating an account that is already active in another workspace hits the
    // active-channel uniqueness index. The DB correctly rejects it (one live channel
    // per account) — surface that as a clean conflict, not a 500.
    if (isUniqueViolation(err)) {
      return ApiErrors.conflict("This account is already connected and active in another workspace");
    }
    throw err;
  }

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
  const result = await db
    .delete(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspace_id, auth.workspaceId)));
  if ((result.rowCount ?? 0) === 0) return ApiErrors.notFound();

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelDisconnected,
    targetType: "channel",
    targetId: channelId,
  });

  return noContent();
}
