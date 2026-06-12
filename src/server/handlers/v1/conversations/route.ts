import { and, eq, lt, or, isNull, desc, sql, type SQL } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { conversations } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  status: z.enum(["open", "closed", "snoozed"]).optional(),
  channel_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(), // opaque keyset cursor
});

// Keyset cursor over (last_message_at DESC NULLS LAST, id DESC). Carrying the id tie-breaker
// means a next page is always reachable — even when the boundary row's last_message_at is NULL,
// which a bare-timestamp cursor could never page past (same class as the contacts cursor).
function encodeCursor(ts: Date | null, id: string): string {
  return Buffer.from(JSON.stringify({ t: ts ? ts.toISOString() : null, i: id })).toString("base64url");
}
function decodeCursor(c: string): { ts: Date | null; id: string } | null {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { t: unknown; i: unknown };
    if (typeof o.i !== "string") return null;
    if (o.t !== null && (typeof o.t !== "string" || Number.isNaN(Date.parse(o.t)))) return null;
    return { ts: o.t === null ? null : new Date(o.t as string), id: o.i };
  } catch {
    return null;
  }
}

// GET /api/v1/conversations
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "conversations:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  const { status, channel_id, limit, cursor } = parsed.data;

  const conds: SQL[] = [eq(conversations.workspace_id, auth.workspaceId)];
  if (status) conds.push(eq(conversations.status, status));
  if (channel_id) conds.push(eq(conversations.channel_id, channel_id));
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (!cur) return ApiErrors.validationError({ cursor: ["invalid cursor"] });
    // Rows ordered AFTER the cursor under (last_message_at DESC NULLS LAST, id DESC).
    conds.push(
      cur.ts !== null
        ? or(
            lt(conversations.last_message_at, cur.ts),
            and(eq(conversations.last_message_at, cur.ts), lt(conversations.id, cur.id)),
            isNull(conversations.last_message_at), // the NULL group sorts after any timestamp
          )!
        : and(isNull(conversations.last_message_at), lt(conversations.id, cur.id))!,
    );
  }

  const rows = await db.query.conversations.findMany({
    where: and(...conds),
    orderBy: [sql`${conversations.last_message_at} desc nulls last`, desc(conversations.id)],
    limit: limit + 1,
    columns: {
      id: true,
      platform: true,
      status: true,
      last_message_at: true,
      last_message_preview: true,
      unread_count: true,
      is_automation_paused: true,
      assigned_to: true, // readable, not just writable
    },
    with: {
      channel: { columns: { id: true, display_name: true, platform: true } },
      contact: {
        columns: { id: true, display_name: true, avatar_url: true },
        with: { contact_channels: { columns: { platform_sender_id: true, platform_username: true }, limit: 1 } },
      },
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  // The id tie-breaker is in the cursor, so it's always present (never null) when there's a
  // next page — even when the boundary row has NULL last_message_at.
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.last_message_at ?? null, last.id) : null;

  return ok(items, { has_more: hasMore, next_cursor: nextCursor });
}
