import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  const { q, tag, limit, cursor } = parsed.data;

  const contacts = await prisma.contact.findMany({
    where: {
      workspace_id: auth.workspaceId,
      ...(q
        ? {
            OR: [
              { display_name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              {
                contact_channels: {
                  some: {
                    OR: [
                      { platform_username: { contains: q, mode: "insensitive" } },
                      { platform_sender_id: { contains: q } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
      ...(tag
        ? { tags: { some: { tag: { name: tag } } } }
        : {}),
      ...(cursor
        ? { last_interaction_at: { lt: new Date(cursor) } }
        : {}),
    },
    orderBy: { last_interaction_at: "desc" },
    take: limit + 1,
    select: {
      id: true,
      display_name: true,
      email: true,
      avatar_url: true,
      is_subscribed: true,
      last_interaction_at: true,
      contact_channels: {
        select: { platform_sender_id: true, platform_username: true, channel: { select: { platform: true } } },
        take: 3,
      },
      tags: {
        select: { tag: { select: { id: true, name: true, color: true } } },
      },
    },
  });

  const hasMore = contacts.length > limit;
  const items = hasMore ? contacts.slice(0, limit) : contacts;
  const nextCursor =
    hasMore && items.length > 0
      ? (items[items.length - 1].last_interaction_at?.toISOString() ?? null)
      : null;

  return ok(items, { has_more: hasMore, next_cursor: nextCursor });
}
