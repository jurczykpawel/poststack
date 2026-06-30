import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts } from "@/db/schema";

/** A Drizzle db or an open transaction — anything exposing the relational `.query` builder. */
type QueryExecutor = Pick<typeof db, "query">;

/**
 * Is this contact still subscribed (consent to receive automated messages)?
 *
 * The single source of truth for the unsubscribe gate, shared by every automated send path so
 * they cannot drift: the approve handler, the AI-draft autosend decision, sequence-step,
 * follow-gate and the outgoing-message delivery worker all answer this the same way. Pass an
 * open transaction to read inside the caller's tx (e.g. the approve flip), or `db` for a
 * standalone read.
 */
export async function isContactSubscribed(exec: QueryExecutor, contactId: string): Promise<boolean> {
  const contact = await exec.query.contacts.findFirst({
    where: eq(contacts.id, contactId),
    columns: { is_subscribed: true },
  });
  return !!contact?.is_subscribed;
}
