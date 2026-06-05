const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface RephraseOptions {
  /** Full system prompt override. Takes precedence over `tone`. */
  customPrompt?: string;
  /** Desired tone, used when no custom prompt is given. */
  tone?: string;
}

/**
 * Rephrase a message to sound natural and varied while keeping its meaning.
 * Provider-agnostic (any OpenAI-compatible chat-completions endpoint, set via
 * OPENAI_BASE_URL + AI_REPHRASE_MODEL). Best-effort: returns the original text
 * unchanged if no key is configured or the call fails. Keeps the rule engine
 * free of any provider-specific code.
 */
export async function rephrase(baseText: string, opts: RephraseOptions = {}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return baseText;

  const model = process.env.AI_REPHRASE_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const tone = opts.tone ?? "friendly and professional";
  const systemContent = opts.customPrompt
    ? opts.customPrompt
    : `You rephrase messages to sound natural and varied while keeping the same meaning and intent. Tone: ${tone}. Reply with ONLY the rephrased message, nothing else. Keep it similar length. Do not add greetings or sign-offs unless the original has them.`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        temperature: 0.8,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: baseText },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return baseText;

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const rephrased = data.choices?.[0]?.message?.content?.trim();
    return rephrased && rephrased.length > 0 ? rephrased : baseText;
  } catch {
    return baseText;
  }
}
