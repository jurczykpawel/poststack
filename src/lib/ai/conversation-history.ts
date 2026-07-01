import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, commentLogs } from "@/db/schema";

const DEFAULT_HISTORY_TURNS = 5;
const MAX_TURN_CHARS = 300;

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)}…` : t;
}

/**
 * Recent back-and-forth in a DM conversation, oldest first, EXCLUDING the newest row — that's the
 * triggering inbound message, which the caller already sends separately as "Message: ...".
 */
async function resolveDmHistory(conversationId: string, turns: number): Promise<string[]> {
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [desc(messages.created_at)],
    limit: turns + 1,
    columns: { direction: true, text: true },
  });
  return rows
    .slice(1) // drop the newest (the triggering message)
    .reverse()
    .filter((r) => r.text?.trim())
    .map((r) => `${r.direction === "inbound" ? "Customer" : "You"}: ${clip(r.text!)}`);
}

/**
 * Recent back-and-forth in a comment thread, oldest first, EXCLUDING the newest row (the triggering
 * comment). A commentLogs row carries both sides of one exchange — the comment and, if it was
 * already answered, the reply that was sent — as up to two turns from one row.
 */
async function resolveCommentHistory(conversationId: string, turns: number): Promise<string[]> {
  const rows = await db.query.commentLogs.findMany({
    where: eq(commentLogs.conversation_id, conversationId),
    orderBy: [desc(commentLogs.created_at)],
    limit: turns + 1,
    columns: { comment_text: true, reply_text: true, reply_sent: true },
  });
  const out: string[] = [];
  for (const r of rows.slice(1).reverse()) {
    if (r.comment_text?.trim()) out.push(`Customer: ${clip(r.comment_text)}`);
    if (r.reply_sent && r.reply_text?.trim()) out.push(`You: ${clip(r.reply_text)}`);
  }
  return out;
}

/**
 * ADCTX3: the last few turns of a conversation, formatted as a compact transcript, for the AI-draft
 * prompt — so a reply to "yes please" or "and the price?" isn't generated blind to what came before.
 * Shared by BOTH the on-demand ("Generate reply" button) and automatic (rule no-match) draft paths —
 * a single resolver, so the two can never build context differently. Excludes the triggering
 * message/comment itself (the caller sends that separately) and caps both the turn count and each
 * turn's length so history can't balloon the prompt. `undefined` when there's nothing before the
 * triggering message (a fresh thread).
 */
export async function resolveConversationHistory(
  conversationId: string,
  isComment: boolean,
  turns: number = DEFAULT_HISTORY_TURNS,
): Promise<string | undefined> {
  const lines = isComment
    ? await resolveCommentHistory(conversationId, turns)
    : await resolveDmHistory(conversationId, turns);
  return lines.length ? `Recent conversation:\n${lines.join("\n")}` : undefined;
}
