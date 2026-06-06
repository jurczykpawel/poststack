import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, ApiErrors } from "@/lib/api/response";
import { drainChannel } from "@/lib/channels/drain";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";

export const runtime = "nodejs";

// POST /api/v1/channels/:channelId/drain — force a replay of held messages (REL5)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!channel) return ApiErrors.notFound("Channel");

  const result = await drainChannel(channelId);

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelDrained,
    targetType: "channel",
    targetId: channelId,
    metadata: { enqueued: result.enqueued, expired: result.expired },
  });

  return ok(result);
}
