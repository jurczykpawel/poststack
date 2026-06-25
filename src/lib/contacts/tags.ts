import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { tags, contactTags } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Upsert tag NAMES for the workspace and link them to a contact — additive and idempotent. Missing
 * names are created (the (workspace_id, name) unique index arbitrates), existing links no-op via the
 * (contact_id, tag_id) PK. Shared by contact import and the rule engine's auto-tag action so neither
 * grows its own copy. Runs inside the caller's transaction.
 */
export async function applyTagsByName(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  names: string[] | undefined,
): Promise<void> {
  const unique = [...new Set((names ?? []).map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return;
  await tx
    .insert(tags)
    .values(unique.map((name) => ({ workspace_id: workspaceId, name })))
    .onConflictDoNothing({ target: [tags.workspace_id, tags.name] });
  const rows = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.workspace_id, workspaceId), inArray(tags.name, unique)));
  if (rows.length === 0) return;
  await tx
    .insert(contactTags)
    .values(rows.map((r) => ({ contact_id: contactId, tag_id: r.id })))
    .onConflictDoNothing();
}
