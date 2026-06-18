import { and, asc, eq, isNull } from "drizzle-orm";
import { db, isUniqueViolation } from "@/lib/db";
import { brands, channels } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { STORY_TEMPLATES } from "@/lib/stories";

export type BrandRow = typeof brands.$inferSelect;

/** A brand's auto-Story template id must be a known (built-in or registered) template. null/"" clears
 *  it (→ the renderer's default). Validated against the live registry so PRO custom templates pass too. */
function validateStoryTemplate(id: string | null | undefined): string | null {
  if (id === undefined || id === null || id === "") return null;
  if (!STORY_TEMPLATES[id]) throw new ApiError("invalid_request", `Unknown story template '${id}'`, 400);
  return id;
}

/** A DB executor: the pool client or a transaction handle. */
export type DbExec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createBrand(
  input: { key: string; name: string; accent?: string | null; icon?: string | null; story_template?: string | null },
  workspaceId: string,
  exec: DbExec = db,
): Promise<BrandRow> {
  const key = input.key.trim();
  if (!key) throw new ApiError("invalid_request", "Brand key is required", 400);
  if (!input.name?.trim()) throw new ApiError("invalid_request", "Brand name is required", 400);
  const story_template = validateStoryTemplate(input.story_template);
  const inserted = await exec
    .insert(brands)
    .values({ workspace_id: workspaceId, key, name: input.name.trim(), accent: input.accent ?? null, icon: input.icon ?? null, story_template })
    .returning()
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new ApiError("conflict", "This brand already exists", 409);
      throw err;
    });
  return inserted[0]!;
}

export async function listBrands(workspaceId: string): Promise<BrandRow[]> {
  return db.query.brands.findMany({ where: eq(brands.workspace_id, workspaceId), orderBy: [asc(brands.name)] });
}

export async function getBrand(workspaceId: string, key: string): Promise<BrandRow | undefined> {
  return db.query.brands.findFirst({ where: and(eq(brands.workspace_id, workspaceId), eq(brands.key, key)) });
}

export async function updateBrand(
  workspaceId: string,
  key: string,
  patch: { name?: string; accent?: string | null; icon?: string | null; story_template?: string | null },
): Promise<BrandRow> {
  const set: Partial<typeof brands.$inferInsert> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.accent !== undefined) set.accent = patch.accent;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.story_template !== undefined) set.story_template = validateStoryTemplate(patch.story_template);
  const [row] = await db
    .update(brands)
    .set(set)
    .where(and(eq(brands.workspace_id, workspaceId), eq(brands.key, key)))
    .returning();
  if (!row) throw new ApiError("not_found", "Brand not found", 404);
  return row;
}

export async function deleteBrand(workspaceId: string, key: string): Promise<void> {
  // The composite brand FK is NOT ON DELETE SET NULL (that would null workspace_id too). Unassign
  // the brand's channels first (brand_key → NULL), then delete the brand — atomically.
  const deleted = await db.transaction(async (tx) => {
    await tx
      .update(channels)
      .set({ brand_key: null, updated_at: new Date() })
      .where(and(eq(channels.workspace_id, workspaceId), eq(channels.brand_key, key)));
    return tx
      .delete(brands)
      .where(and(eq(brands.workspace_id, workspaceId), eq(brands.key, key)))
      .returning({ key: brands.key });
  });
  if (deleted.length === 0) throw new ApiError("not_found", "Brand not found", 404);
}

/** Assign a channel to a brand (or clear with null), scoped to the workspace. The composite FK
 *  already guarantees a channel can only join a brand in its own workspace; we validate for a
 *  friendly error. */
export async function assignChannelBrand(workspaceId: string, channelId: string, brandKey: string | null): Promise<void> {
  if (brandKey !== null) {
    const brand = await getBrand(workspaceId, brandKey);
    if (!brand) throw new ApiError("invalid_request", `Unknown brand '${brandKey}'`, 400);
  }
  const res = await db
    .update(channels)
    .set({ brand_key: brandKey, updated_at: new Date() })
    .where(and(eq(channels.id, channelId), eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)))
    .returning({ id: channels.id });
  if (res.length === 0) throw new ApiError("not_found", "Channel not found", 404);
}
