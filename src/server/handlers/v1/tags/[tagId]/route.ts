import { and, eq, ne, sql } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db, isUniqueViolation } from "@/lib/db";
import { tags } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { z } from "zod";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ tagId: string }> };

const patchSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

// PATCH /api/v1/tags/:tagId — rename / recolor a tag.
export async function PATCH(request: Request, { params }: Ctx) {
  const auth = await authenticateWithScope(request, "tags:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { tagId } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error);

  const existing = await db.query.tags.findFirst({
    where: and(eq(tags.id, tagId), eq(tags.workspace_id, auth.workspaceId)),
    columns: { id: true, name: true, color: true },
  });
  if (!existing) return ApiErrors.notFound("Tag");

  const { name, color } = parsed.data;
  if (name === undefined && color === undefined) return ok(existing); // no-op

  // Case-insensitive name collision against OTHER tags in this workspace (renaming to your own
  // name, even re-cased, is fine). The unique (workspace_id, name) index is the race backstop below.
  if (name !== undefined) {
    const clash = await db.query.tags.findFirst({
      where: and(
        eq(tags.workspace_id, auth.workspaceId),
        ne(tags.id, tagId),
        sql`lower(${tags.name}) = lower(${name})`,
      ),
      columns: { id: true },
    });
    if (clash) return ApiErrors.conflict("Tag with this name already exists");
  }

  try {
    const [row] = await db
      .update(tags)
      .set({ ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) })
      .where(and(eq(tags.id, tagId), eq(tags.workspace_id, auth.workspaceId)))
      .returning({ id: tags.id, name: tags.name, color: tags.color });
    if (!row) return ApiErrors.notFound("Tag"); // erased between the precheck and the update
    return ok(row);
  } catch (err) {
    // Concurrent same-name rename: the (workspace_id, name) unique index arbitrates → clean 409.
    if (isUniqueViolation(err)) return ApiErrors.conflict("Tag with this name already exists");
    throw err;
  }
}

// DELETE /api/v1/tags/:tagId — remove a tag; its contact links cascade (contact_tags FK ON DELETE cascade).
export async function DELETE(request: Request, { params }: Ctx) {
  const auth = await authenticateWithScope(request, "tags:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { tagId } = await params;
  const [deleted] = await db
    .delete(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspace_id, auth.workspaceId)))
    .returning({ id: tags.id });
  if (!deleted) return ApiErrors.notFound("Tag");
  return noContent();
}
