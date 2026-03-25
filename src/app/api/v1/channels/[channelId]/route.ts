import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/channels/:channelId
export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
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
      is_active: true,
      created_at: true,
    },
  });

  if (!channel) return ApiErrors.notFound();
  return ok(channel);
}

const patchSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
});

// PATCH /api/v1/channels/:channelId — update name or toggle active
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
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

  const updated = await prisma.channel.update({
    where: { id: channelId },
    data: parsed.data,
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

  return ok(updated);
}

// DELETE /api/v1/channels/:channelId — disconnect channel
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const existing = await prisma.channel.findFirst({
    where: { id: channelId, workspace_id: auth.workspaceId },
  });
  if (!existing) return ApiErrors.notFound();

  await prisma.channel.delete({ where: { id: channelId } });
  return noContent();
}
