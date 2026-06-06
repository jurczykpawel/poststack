import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { noContent, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

// DELETE /api/v1/api-keys/:keyId
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ keyId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { keyId } = await params;
  const existing = await prisma.apiKey.findFirst({
    where: { id: keyId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  await prisma.apiKey.delete({ where: { id: keyId } });
  return noContent();
}
