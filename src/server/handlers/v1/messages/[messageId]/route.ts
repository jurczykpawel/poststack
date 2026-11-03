import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { messages, conversations } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";

export const runtime = "nodejs";

// GET /api/v1/messages/:id — the content behind a message.received event
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:read");
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { messageId } = await params;
  const [row] = await db
    .select({
      id: messages.id,
      conversation_id: messages.conversation_id,
      direction: messages.direction,
      text: messages.text,
      status: messages.status,
      platform_message_id: messages.platform_message_id,
      created_at: messages.created_at,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversation_id))
    .where(and(eq(messages.id, messageId), eq(conversations.workspace_id, auth.workspaceId)));
  return row ? ok(row) : ApiErrors.notFound();
}
