import { and, eq } from "drizzle-orm";
import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@/db/schema";
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
  const result = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspace_id, auth.workspaceId)));
  if ((result.rowCount ?? 0) === 0) return ApiErrors.notFound();
  return noContent();
}
