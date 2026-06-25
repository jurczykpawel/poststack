import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, contactChannels, channels } from "@/db/schema";
import { applyTagsByName } from "@/lib/contacts/tags";
import { emitEvent } from "@/lib/events";

export interface ImportContactInput {
  channel_id: string;
  platform_sender_id?: string;
  platform_username?: string;
  display_name?: string | null;
  email?: string | null;
  is_subscribed?: boolean;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ImportContactResult {
  index: number;
  status: "created" | "updated" | "error";
  contact_id?: string;
  error?: string;
}

export interface ImportSummary {
  created: number;
  updated: number;
  failed: number;
  results: ImportContactResult[];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Only the explicitly-provided fields are written (merge, not overwrite): metadata is a race-free
// jsonb concat so a re-import adds keys without clobbering existing ones.
async function applyContactFields(tx: Tx, contactId: string, workspaceId: string, row: ImportContactInput): Promise<void> {
  const set = {
    ...(row.display_name !== undefined ? { display_name: row.display_name } : {}),
    ...(row.email !== undefined ? { email: row.email } : {}),
    ...(row.is_subscribed !== undefined ? { is_subscribed: row.is_subscribed } : {}),
    ...(row.metadata !== undefined
      ? { metadata: sql`COALESCE(${contacts.metadata}, '{}'::jsonb) || ${JSON.stringify(row.metadata)}::jsonb` }
      : {}),
  };
  if (Object.keys(set).length === 0) return;
  // workspace_id alongside the id keeps the update tenant-scoped (defense-in-depth).
  await tx.update(contacts).set(set).where(and(eq(contacts.id, contactId), eq(contacts.workspace_id, workspaceId)));
}

async function upsertOne(
  row: ImportContactInput,
  senderId: string,
  workspaceId: string,
): Promise<{ status: "created" | "updated"; contactId: string }> {
  const existing = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.channel_id, row.channel_id), eq(contactChannels.platform_sender_id, senderId)),
    columns: { contact_id: true, platform_username: true },
  });

  if (existing) {
    await db.transaction(async (tx) => {
      await applyContactFields(tx, existing.contact_id, workspaceId, row);
      if (row.platform_username && row.platform_username !== existing.platform_username) {
        await tx
          .update(contactChannels)
          .set({ platform_username: row.platform_username })
          .where(and(eq(contactChannels.channel_id, row.channel_id), eq(contactChannels.platform_sender_id, senderId)));
      }
      await applyTagsByName(tx, workspaceId, existing.contact_id, row.tags);
    });
    return { status: "updated", contactId: existing.contact_id };
  }

  // New identity. Mirror resolveContactId's race handling: the unique (channel_id, platform_sender_id)
  // index arbitrates a concurrent first insert; the loser rolls back its orphan contact and updates the
  // winner instead of throwing a 23505.
  const LOST_RACE = Symbol("contact-channel-race");
  try {
    const contactId = await db.transaction(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({
          workspace_id: workspaceId,
          display_name: row.display_name ?? null,
          email: row.email ?? null,
          is_subscribed: row.is_subscribed ?? true,
          metadata: row.metadata ?? {},
        })
        .returning({ id: contacts.id });
      const [link] = await tx
        .insert(contactChannels)
        .values({ contact_id: contact.id, channel_id: row.channel_id, platform_sender_id: senderId, platform_username: row.platform_username ?? null })
        .onConflictDoNothing({ target: [contactChannels.channel_id, contactChannels.platform_sender_id] })
        .returning({ contact_id: contactChannels.contact_id });
      if (!link) throw LOST_RACE;
      await applyTagsByName(tx, workspaceId, contact.id, row.tags);
      // contact.created fires only when THIS call inserted the surviving contact (a re-import that
      // updates an existing one is not a creation). Emitted in-tx so the outbound-webhook fan-out
      // (WHOUT1) commits atomically with the contact — integrators get "new contact" without polling.
      await emitEvent(tx, workspaceId, "contact.created", { type: "contact", id: contact.id });
      return contact.id;
    });
    return { status: "created", contactId };
  } catch (err) {
    if (err !== LOST_RACE) throw err;
    const winner = await db.query.contactChannels.findFirst({
      where: and(eq(contactChannels.channel_id, row.channel_id), eq(contactChannels.platform_sender_id, senderId)),
      columns: { contact_id: true },
    });
    await db.transaction(async (tx) => {
      await applyContactFields(tx, winner!.contact_id, workspaceId, row);
      await applyTagsByName(tx, workspaceId, winner!.contact_id, row.tags);
    });
    return { status: "updated", contactId: winner!.contact_id };
  }
}

/**
 * Bulk create-or-update contacts for an import (e.g. a ManyChat audience export). Dedup is by
 * (channel_id, platform_sender_id); when only a handle is known, the caller passes it as
 * platform_username and we key on it as a placeholder sender id — the real Meta sender id is filled
 * in on the contact's first inbound event. Per-row failures (unknown channel, …) are reported, not
 * fatal, so one bad row never aborts the batch.
 */
export async function upsertImportedContacts(rows: ImportContactInput[], workspaceId: string): Promise<ImportSummary> {
  const channelIds = [...new Set(rows.map((r) => r.channel_id))];
  const validChannels = new Set(
    (
      await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(inArray(channels.id, channelIds), eq(channels.workspace_id, workspaceId)))
    ).map((c) => c.id),
  );

  const results: ImportContactResult[] = [];
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const senderId = row.platform_sender_id ?? row.platform_username;
    if (!senderId) {
      results.push({ index: i, status: "error", error: "platform_sender_id or platform_username is required" });
      failed++;
      continue;
    }
    if (!validChannels.has(row.channel_id)) {
      results.push({ index: i, status: "error", error: "channel not found" });
      failed++;
      continue;
    }
    try {
      const res = await upsertOne(row, senderId, workspaceId);
      results.push({ index: i, status: res.status, contact_id: res.contactId });
      if (res.status === "created") created++;
      else updated++;
    } catch (err) {
      results.push({ index: i, status: "error", error: err instanceof Error ? err.message : "import failed" });
      failed++;
    }
  }

  return { created, updated, failed, results };
}
