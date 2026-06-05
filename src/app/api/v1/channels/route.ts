import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

// GET /api/v1/channels — list all channels for the workspace
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "channels:read");
  if (!auth) return ApiErrors.unauthorized();

  const channels = await prisma.channel.findMany({
    where: { workspace_id: auth.workspaceId },
    orderBy: { created_at: "asc" },
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

  // `is_active` kept as a computed alias for backward compatibility.
  return ok(channels.map((c) => ({ ...c, is_active: c.status === "active" })));
}
