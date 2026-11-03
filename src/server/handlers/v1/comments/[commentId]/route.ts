import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { commentLogs } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";

export const runtime = "nodejs";

// GET /api/v1/comments/:id — the content behind a comment.received event
export async function GET(
  request: Request,
  { params }: { params: Promise<{ commentId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:read");
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { commentId } = await params;
  const comment = await db.query.commentLogs.findFirst({
    where: and(eq(commentLogs.id, commentId), eq(commentLogs.workspace_id, auth.workspaceId)),
    columns: {
      id: true,
      conversation_id: true,
      channel_id: true,
      post_id: true,
      post_url: true,
      platform_comment_id: true,
      author_name: true,
      comment_text: true,
      created_at: true,
    },
  });
  return comment ? ok(comment) : ApiErrors.notFound();
}
