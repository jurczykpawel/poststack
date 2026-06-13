import { randomUUID } from "crypto";
import { and, eq, lt, desc, sql, type SQL } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { messages, conversations, contactChannels } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { addJobTx } from "@/lib/queue/client";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // The cursor is an ISO timestamp (the previous page's `next_cursor`). Validate it as such so a
  // garbage value is a clean 400 instead of an Invalid Date that throws when Drizzle serializes the
  // query param → 500. Matches what `next_cursor` emits via Date.toISOString().
  cursor: z.string().datetime().optional(),
});

// GET /api/v1/conversations/:id/messages
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

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
  // Manual (human) replying is PRO — free relies on rule auto-replies, and handles a needs-reply
  // case in the native app. Rule-driven sends go through the worker, not here, so they stay free.
  const gate = await proGate("manual_reply");
  if (gate) return gate;

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

  // A client that retries after a timeout/lost response must not create a second reply.
  // When the caller supplies Idempotency-Key, derive a deterministic key (scoped to the
  // workspace+conversation) and use it as the graphile job key AND the outbound send key —
  // so a repeat enqueues at most one job and sends at most once. Without a key we
  // fall back to a fresh uuid (each call is independent).
  const idemHeader = request.headers.get("Idempotency-Key");
  // graphile-worker hard-caps job_key at 512 chars; the key embeds two UUIDs + a prefix, so an
  // unbounded header would overflow it and surface as a 500. Bound it well under the limit.
  if (idemHeader && idemHeader.length > 200) {
    return ApiErrors.badRequest("Idempotency-Key must be at most 200 characters");
  }
  const replyKey = idemHeader
    ? `manual-reply:${auth.workspaceId}:${conversation.id}:${idemHeader}`
    : randomUUID();

  // Clear the manual-attention flag and enqueue the reply in ONE transaction: if
  // the enqueue fails, the flag stays set so the operator still sees the conversation needs
  // a reply, instead of clearing the alert for a message that never went out.
  //
  // Also advance last_message_at NOW (the human just acted), not later when the reply is
  // sent: that timestamp is the "is this still the latest activity" marker the inbound
  // worker uses, so without this a stale old-inbound final-retry could re-raise the flag in
  // the window before the outgoing job runs. GREATEST keeps it monotonic.
  await db.transaction(async (tx) => {
    await tx.update(conversations)
      .set({ needs_manual_reply: false, last_message_at: sql`GREATEST(${conversations.last_message_at}, now())` })
      // workspace_id alongside the PK keeps the update tenant-scoped.
      .where(and(eq(conversations.id, conversation.id), eq(conversations.workspace_id, auth.workspaceId)));
    await addJobTx(tx, "outgoing-message", {
      channelId: conversation.channel_id,
      conversationId: conversation.id,
      contactId: conversation.contact_id,
      recipientPlatformId: contactChannel.platform_sender_id,
      content: { text: parsed.data.text },
      // sentByUserId is null for api-key auth (it's a users.id FK), but this IS a human reply —
      // carry that explicitly so the worker's human-agent exemption (consent skip + send-while-paused)
      // doesn't silently drop/hold an operator's reply sent via the API (the primary interface).
      sentByUserId: auth.userId.startsWith("api-key:") ? undefined : auth.userId,
      isManual: true,
      idempotencyKey: replyKey,
    }, { jobKey: idemHeader ? replyKey : undefined });
  });

  return created({ queued: true });
}
