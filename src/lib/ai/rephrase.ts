import { chatComplete } from "./client";

export interface RephraseOptions {
  /** Full system prompt override. Takes precedence over `tone`. */
  customPrompt?: string;
  /** Desired tone, used when no custom prompt is given. */
  tone?: string;
}

/**
 * Rephrase a message to sound natural and varied while keeping its meaning.
 * Provider-agnostic (any OpenAI-compatible chat-completions endpoint, set via
 * AI_BASE_URL + AI_MODEL). Best-effort: returns the original text unchanged if
 * no key is configured or the call fails. Keeps the rule engine free of any
 * provider-specific code by delegating to the shared LLM client.
 */
export async function rephrase(baseText: string, opts: RephraseOptions = {}): Promise<string> {
  const tone = opts.tone ?? "friendly and professional";
  const systemContent = opts.customPrompt
    ? opts.customPrompt
    : `You rephrase messages to sound natural and varied while keeping the same meaning and intent. Tone: ${tone}. Reply with ONLY the rephrased message, nothing else. Keep it similar length. Do not add greetings or sign-offs unless the original has them.`;

  const rephrased = await chatComplete({
    system: systemContent,
    user: baseText,
    maxTokens: 300,
    temperature: 0.8,
  });

  return rephrased ?? baseText;
}
