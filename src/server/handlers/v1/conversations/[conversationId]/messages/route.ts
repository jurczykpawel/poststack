import { randomUUID } from "crypto";
import { and, eq, lt, desc, type SQL } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { messages, conversations, contactChannels } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { addJob } from "@/lib/queue/client";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// GET /api/v1/conversations/:id/messages
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!conversation) return ApiErrors.notFound();

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  const { limit, cursor } = parsed.data;

  const conds: SQL[] = [eq(messages.conversation_id, conversationId)];
  if (cursor) conds.push(lt(messages.created_at, new Date(cursor)));

  const rows = await db.query.messages.findMany({
    where: and(...conds),
    orderBy: desc(messages.created_at),
    limit: limit + 1,
    columns: {
      id: true,
      direction: true,
      text: true,
      status: true,
      platform_message_id: true,
      sent_by_rule_id: true,
      sent_by_user_id: true,
      created_at: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].created_at.toISOString() : null;

  // Return in chronological order (oldest first) for the UI
  return ok([...items].reverse(), { has_more: hasMore, next_cursor: nextCursor });
}

const sendSchema = z.object({
  text: z.string().min(1).max(2000),
});

// POST /api/v1/conversations/:id/messages — manual reply
export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.workspace_id, auth.workspaceId)),
    columns: { id: true, channel_id: true, contact_id: true },
  });
  if (!conversation) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const contactChannel = await db.query.contactChannels.findFirst({
    where: and(
      eq(contactChannels.contact_id, conversation.contact_id),
      eq(contactChannels.channel_id, conversation.channel_id),
    ),
    columns: { platform_sender_id: true },
  });
  if (!contactChannel) {
    return ApiErrors.badRequest("No platform identity found for this contact");
  }

  // Clear needs_manual_reply flag (human is responding)
  await db.update(conversations).set({ needs_manual_reply: false }).where(eq(conversations.id, conversation.id));

  // Enqueue outgoing message
  await addJob("outgoing-message", {
    channelId: conversation.channel_id,
    conversationId: conversation.id,
    contactId: conversation.contact_id,
    recipientPlatformId: contactChannel.platform_sender_id,
    content: { text: parsed.data.text },
    sentByUserId: auth.userId.startsWith("api-key:") ? undefined : auth.userId,
    idempotencyKey: randomUUID(),
  });

  return created({ queued: true });
}
