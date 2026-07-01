import { chatComplete } from "@/lib/ai/client";

/**
 * Built-in default system prompt used to steer an AI-drafted reply when neither the channel nor the
 * workspace configures one. Sober and conservative: produce only the message text, ready for a human
 * to review/approve.
 */
export const DEFAULT_DRAFT_PROMPT =
  "You draft a concise, on-brand reply to a customer's message or comment. " +
  "The user message states the reply target and labels the text to reply to — match your tone to " +
  "that target: public comment replies must stay appropriate for a public audience, DMs can be more personal. " +
  "Reply with ONLY the message text — no greetings or sign-offs unless natural, no quotes, no preamble. " +
  "Keep it short and helpful. If the message is unclear, ask one brief clarifying question.";

/** A non-blank string (trimmed) or `undefined` if the value is unset/blank/whitespace-only. */
function nonBlank(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the system prompt that steers draft generation, by precedence:
 * per-channel override → per-workspace default → built-in `DEFAULT_DRAFT_PROMPT`.
 * Blank / whitespace-only values are treated as unset.
 */
export function resolveDraftPrompt(args: {
  channelPrompt?: string | null;
  workspacePrompt?: string | null;
}): string {
  return nonBlank(args.channelPrompt) ?? nonBlank(args.workspacePrompt) ?? DEFAULT_DRAFT_PROMPT;
}

/** How the reply target reads in the prompt, per surface(s) the draft will be sent to. */
function describeReplyTarget(target: "dm" | "public" | "both"): string {
  if (target === "dm") return "a private direct message";
  if (target === "public") return "a public comment reply";
  return "a public comment reply (also sent as a DM)";
}

/**
 * Draft a reply to an incoming comment/DM via the shared LLM client. The `prompt` becomes the system
 * message; the user message is built from (optional) light context, an explicit reply-target line
 * (ADCTX4 — so the model knows whether it's writing for a public audience or a private DM, since that
 * never differed in the raw prompt before, even though the caller always knew it), and the incoming
 * text labeled as the customer's newest turn. The label reuses the transcript's `Customer` voice (so
 * the model reads it as the same speaker as the history, not a new role) and names its own surface
 * ("public comment" vs "direct message" — distinct from the reply target: a comment can be answered
 * via DM, and a comment→DM automation answers both at once) plus which message to reply to.
 * Best-effort: returns chatComplete's result verbatim — a trimmed string, or `null` (no key / failure
 * / empty completion), in which case the caller creates no draft.
 */
export async function generateDraft(args: {
  workspaceId: string;
  conversationId: string;
  incomingText: string;
  isComment: boolean;
  target: "dm" | "public" | "both";
  context?: string;
  prompt: string;
}): Promise<string | null> {
  const surface = args.isComment ? "new public comment" : "new direct message";
  const source = `Customer (${surface} — the message to reply to)`;
  const instruction = `Reply target: ${describeReplyTarget(args.target)}\n${source}: ${args.incomingText}`;
  const user = args.context ? `${args.context}\n\n---\n${instruction}` : instruction;

  return chatComplete({
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    kind: "draft",
    system: args.prompt,
    user,
    maxTokens: 400,
    temperature: 0.7,
  });
}
