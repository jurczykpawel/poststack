import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

// GET /api/v1/channels — list all channels for the workspace
export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
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
      is_active: true,
      created_at: true,
    },
  });

  return ok(channels);
}
