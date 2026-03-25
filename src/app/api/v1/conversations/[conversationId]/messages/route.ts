import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { outgoingMessagesQueue } from "@/lib/queue/client";
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
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!conversation) return ApiErrors.notFound();

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  const { limit, cursor } = parsed.data;

  const messages = await prisma.message.findMany({
    where: {
      conversation_id: conversationId,
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: limit + 1,
    select: {
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

  const hasMore = messages.length > limit;
  const items = hasMore ? messages.slice(0, limit) : messages;
  const nextCursor =
    hasMore && items.length > 0
      ? items[items.length - 1].created_at.toISOString()
      : null;

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
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspace_id: auth.workspaceId },
    select: {
      id: true,
      channel_id: true,
      contact: {
        select: {
          id: true,
          contact_channels: {
            where: { channel: { id: { not: undefined } } },
            select: { platform_sender_id: true, channel_id: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!conversation) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const contactChannel = conversation.contact.contact_channels.find(
    (cc) => cc.channel_id === conversation.channel_id
  );
  if (!contactChannel) {
    return ApiErrors.badRequest("No platform identity found for this contact");
  }

  // Enqueue outgoing message
  await outgoingMessagesQueue.add("outgoing-message", {
    channelId: conversation.channel_id,
    conversationId: conversation.id,
    contactId: conversation.contact.id,
    recipientPlatformId: contactChannel.platform_sender_id,
    content: { text: parsed.data.text },
    sentByUserId: auth.userId !== "api-key" ? auth.userId : undefined,
  });

  return created({ queued: true });
}
