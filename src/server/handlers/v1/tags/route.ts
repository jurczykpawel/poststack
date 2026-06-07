import { and, eq, asc, sql } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { tags, contactTags } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/tags
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "tags:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const rows = await db.query.tags.findMany({
    where: eq(tags.workspace_id, auth.workspaceId),
    orderBy: asc(tags.name),
    limit: 500,
    columns: { id: true, name: true, color: true },
  });

  const withCounts = await Promise.all(
    rows.map(async (t) => ({
      ...t,
      _count: { contacts: await db.$count(contactTags, eq(contactTags.tag_id, t.id)) },
    })),
  );

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

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const existing = await db.query.tags.findFirst({
    where: and(eq(tags.workspace_id, auth.workspaceId), sql`lower(${tags.name}) = lower(${parsed.data.name})`),
    columns: { id: true },
  });
  if (existing) return ApiErrors.conflict("Tag with this name already exists");

  const [tag] = await db
    .insert(tags)
    .values({ workspace_id: auth.workspaceId, name: parsed.data.name, color: parsed.data.color })
    .returning();

  return created(tag);
}
