import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, conversations } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { extractCaptured, type CaptureField } from "./capture";

/** The transaction handle db.transaction passes to its callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface CaptureInput {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  field: CaptureField;
  text: string | null;
}

/**
 * Resolve a conversation's armed email/phone capture for an inbound message. Validates the text,
 * writes it to the contact's matching field, ALWAYS clears the arming flag (one-shot — a junk reply
 * must not leave the conversation stuck waiting), and on a successful capture emits `contact.updated`
 * so a subscribed outbound webhook can forward the contact to a mailing list (Listmonk, n8n, …).
 *
 * Runs inside the caller's transaction so the capture commits atomically with the inbound message.
 * Returns the stored value, or null when nothing usable was found. Every write is workspace-scoped.
 */
export async function applyCapture(tx: DbTx, input: CaptureInput): Promise<string | null> {
  const value = extractCaptured(input.field, input.text);

  // Clear the flag regardless of validity (one-shot) — scoped to the workspace.
  await tx
    .update(conversations)
    .set({ awaiting_capture: null })
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.workspace_id, input.workspaceId)));

  if (!value) return null;

  await tx
    .update(contacts)
    .set(input.field === "email" ? { email: value } : { phone: value })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.workspace_id, input.workspaceId)));

  await emitEvent(tx, input.workspaceId, "contact.updated", { type: "contact", id: input.contactId });

  return value;
}
