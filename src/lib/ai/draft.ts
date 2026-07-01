import { chatComplete } from "@/lib/ai/client";

/**
 * Built-in default system prompt used to steer an AI-drafted reply when neither the channel nor the
 * workspace configures one. Sober and conservative: produce only the message text, ready for a human
 * to review/approve.
 */
export const DEFAULT_DRAFT_PROMPT =
  "You draft a concise, on-brand reply to a customer's message or comment. " +
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

/**
 * Draft a reply to an incoming comment/DM via the shared LLM client. The `prompt` becomes the system
 * message; the incoming text (optionally prefixed with light context) becomes the user message.
 * Best-effort: returns chatComplete's result verbatim — a trimmed string, or `null` (no key / failure
 * / empty completion), in which case the caller creates no draft.
 */
export async function generateDraft(args: {
  workspaceId: string;
  incomingText: string;
  context?: string;
  prompt: string;
}): Promise<string | null> {
  const user = args.context
    ? `${args.context}\n\n---\nMessage: ${args.incomingText}`
    : args.incomingText;

  return chatComplete({
    workspaceId: args.workspaceId,
    kind: "draft",
    system: args.prompt,
    user,
    maxTokens: 400,
    temperature: 0.7,
  });
}
