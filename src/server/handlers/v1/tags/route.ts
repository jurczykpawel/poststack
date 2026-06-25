import { and, eq, asc, sql, inArray, count } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { tags, contactTags } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/tags
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "tags:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const rows = await db.query.tags.findMany({
    where: eq(tags.workspace_id, auth.workspaceId),
    orderBy: asc(tags.name),
    limit: 500,
    columns: { id: true, name: true, color: true },
  });

  // One grouped count for all tags instead of a $count per tag (up to 500 → N+1).
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({ tag_id: contactTags.tag_id, n: count() })
        .from(contactTags)
        .where(inArray(contactTags.tag_id, ids))
        .groupBy(contactTags.tag_id)
    : [];
  const byTag = new Map(counts.map((c) => [c.tag_id, Number(c.n)]));
  const withCounts = rows.map((t) => ({ ...t, _count: { contacts: byTag.get(t.id) ?? 0 } }));

  return ok(withCounts);
}

const createSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1"),
});

// POST /api/v1/tags
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "tags:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error);
  }

  const existing = await db.query.tags.findFirst({
    where: and(eq(tags.workspace_id, auth.workspaceId), sql`lower(${tags.name}) = lower(${parsed.data.name})`),
    columns: { id: true },
  });
  if (existing) return ApiErrors.conflict("Tag with this name already exists");

  // Conflict-aware insert closes the read-then-write race: two concurrent same-name POSTs both miss
  // the read above, so let the (workspace_id, name) unique index arbitrate — the loser's insert is a
  // no-op and returns a clean 409 instead of an uncaught 23505 → 500.
  const [tag] = await db
    .insert(tags)
    .values({ workspace_id: auth.workspaceId, name: parsed.data.name, color: parsed.data.color })
    .onConflictDoNothing({ target: [tags.workspace_id, tags.name] })
    .returning();
  if (!tag) return ApiErrors.conflict("Tag with this name already exists");

  return created(tag);
}
