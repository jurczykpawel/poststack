import type { QuickReply, MessageButton } from "@/lib/platforms/base";

/**
 * Extract the interactive parts of a response (quick replies / buttons) from a
 * rule's response_config. The config was validated at write time, so this only
 * passes the stored arrays through; it defends against bad shapes and drops
 * empty arrays so callers can spread the result without sending empty fields.
 */
export function buildInteractiveContent(
  responseConfig: Record<string, unknown>,
): { quick_replies?: QuickReply[]; buttons?: MessageButton[] } {
  const out: { quick_replies?: QuickReply[]; buttons?: MessageButton[] } = {};
  const qr = responseConfig.quick_replies;
  if (Array.isArray(qr) && qr.length > 0) out.quick_replies = qr as QuickReply[];
  const buttons = responseConfig.buttons;
  if (Array.isArray(buttons) && buttons.length > 0) out.buttons = buttons as MessageButton[];
  return out;
}

/**
 * Resolve the base reply text and whether to AI-rephrase it. The text source
 * (a single `text` or a random pick from `messages`) is orthogonal to AI
 * post-processing: any source can be rephrased when response_type is
 * `ai_rephrase` or response_config sets `ai_rephrase: true`.
 */
export function selectResponse(
  responseType: string,
  responseConfig: Record<string, unknown>,
): { baseText: string | null; aiEnabled: boolean } {
  let baseText: string | null = null;
  if (responseType === "random_text") {
    const msgs = responseConfig.messages as string[] | undefined;
    if (msgs && msgs.length > 0) baseText = msgs[Math.floor(Math.random() * msgs.length)];
  } else if (responseType !== "none" && responseType !== "sequence") {
    baseText = (responseConfig.text as string) ?? null;
  }
  const aiEnabled = responseType === "ai_rephrase" || responseConfig.ai_rephrase === true;
  return { baseText, aiEnabled };
}
