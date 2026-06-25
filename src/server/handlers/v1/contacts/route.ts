import { and, or, eq, lt, isNull, ilike, like, desc, exists, sql, type SQL } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { contacts, contactChannels, contactTags, tags } from "@/db/schema";
import { ok, created, ApiErrors, zodDetails } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { upsertImportedContacts } from "@/lib/contacts/import";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  tag: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});

// Opaque keyset cursor over (last_interaction_at, id). A bare timestamp cursor skipped rows
// that shared the boundary timestamp and could never page past NULL activity; the id
// tie-breaker makes the order total and every page reachable.
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

// GET /api/v1/contacts
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "contacts:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  const { q, tag, limit, cursor } = parsed.data;

  // Escape LIKE wildcards to prevent pattern injection
  const safeQ = q?.replace(/[%_\\]/g, "\\$&");

  const conds: SQL[] = [eq(contacts.workspace_id, auth.workspaceId)];

  if (safeQ) {
    const pat = `%${safeQ}%`;
    conds.push(
      or(
        ilike(contacts.display_name, pat),
        ilike(contacts.email, pat),
        exists(
          db
            .select({ x: sql`1` })
            .from(contactChannels)
            .where(
              and(
                eq(contactChannels.contact_id, contacts.id),
                or(ilike(contactChannels.platform_username, pat), like(contactChannels.platform_sender_id, pat)),
              ),
            ),
        ),
      )!,
    );
  }

  if (tag) {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(contactTags)
          .innerJoin(tags, eq(contactTags.tag_id, tags.id))
          .where(and(eq(contactTags.contact_id, contacts.id), eq(tags.name, tag))),
      ),
    );
  }

  if (cursor) {
    const cur = decodeCursor(cursor);
    if (!cur) return ApiErrors.validationError({ cursor: ["invalid cursor"] });
    // Rows ordered AFTER the cursor under (last_interaction_at DESC NULLS LAST, id DESC).
    conds.push(
      cur.ts !== null
        ? or(
            lt(contacts.last_interaction_at, cur.ts),
            and(eq(contacts.last_interaction_at, cur.ts), lt(contacts.id, cur.id)),
            isNull(contacts.last_interaction_at), // the NULL group sorts after any timestamp
          )!
        : and(isNull(contacts.last_interaction_at), lt(contacts.id, cur.id))!,
    );
  }

  const rows = await db.query.contacts.findMany({
    where: and(...conds),
    orderBy: [sql`${contacts.last_interaction_at} desc nulls last`, desc(contacts.id)],
    limit: limit + 1,
    columns: {
      id: true,
      display_name: true,
      email: true,
      avatar_url: true,
      is_subscribed: true,
      last_interaction_at: true,
    },
    with: {
      contact_channels: {
        columns: { platform_sender_id: true, platform_username: true },
        limit: 3,
        with: { channel: { columns: { platform: true } } },
      },
      tags: {
        columns: {},
        with: { tag: { columns: { id: true, name: true, color: true } } },
      },
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  // Cursor carries the id tie-breaker too, so it is always present (never null) when there
  // is a next page — even when the boundary row has NULL activity.
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.last_interaction_at ?? null, last.id) : null;

  return ok(items, { has_more: hasMore, next_cursor: nextCursor });
}

// A single import row, or a batch of them. Identity on the channel is either the native sender id or
// (for tools that export only a handle, e.g. ManyChat) the username, keyed as a placeholder sender id.
const importRow = z
  .object({
    channel_id: z.string().uuid(),
    platform_sender_id: z.string().min(1).max(255).optional(),
    platform_username: z.string().min(1).max(255).optional(),
    display_name: z.string().min(1).max(200).nullable().optional(),
    email: z.string().email().nullable().optional(),
    is_subscribed: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string().min(1).max(50)).max(100).optional(),
  })
  .refine((r) => !!(r.platform_sender_id || r.platform_username), {
    message: "platform_sender_id or platform_username is required",
  });

const createBody = z.union([importRow, z.array(importRow).min(1).max(1000)]);

// POST /api/v1/contacts — create or update one or many contacts (bulk import). Idempotent: re-running
// the same payload updates rather than duplicates (dedup by channel + sender id).
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "contacts:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const body = await request.json().catch(() => null);
  const parsed = createBody.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));

  const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const summary = await upsertImportedContacts(rows, auth.workspaceId);
  return created(summary);
}
