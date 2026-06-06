import { and, or, eq, lt, ilike, like, desc, exists, sql, type SQL } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { contacts, contactChannels, contactTags, tags } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  q: z.string().optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});

// GET /api/v1/contacts
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "contacts:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

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

  if (cursor) conds.push(lt(contacts.last_interaction_at, new Date(cursor)));

  const rows = await db.query.contacts.findMany({
    where: and(...conds),
    orderBy: desc(contacts.last_interaction_at),
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
  const nextCursor =
    hasMore && items.length > 0
      ? (items[items.length - 1].last_interaction_at?.toISOString() ?? null)
      : null;

  return ok(items, { has_more: hasMore, next_cursor: nextCursor });
}
