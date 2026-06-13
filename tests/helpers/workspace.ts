// Test helper: seed a workspace (tenant) and return its id, so publishing/multi-tenant tests can
// scope every row to it. RS seeds workspaces inline today; this DRYs the new publishing suites.
import { randomUUID } from "crypto";

export async function seedWorkspace(
  db: typeof import("@/lib/db").db,
  schema: typeof import("@/db/schema"),
  over: { id?: string; name?: string; slug?: string } = {},
): Promise<string> {
  const id = over.id ?? randomUUID();
  await db
    .insert(schema.workspaces)
    .values({ id, name: over.name ?? "Test WS", slug: over.slug ?? `ws-${id.slice(0, 8)}` })
    .onConflictDoNothing();
  return id;
}
