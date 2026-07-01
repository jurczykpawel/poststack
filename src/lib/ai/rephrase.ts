import { chatComplete } from "./client";

/** Default tone baked into the built-in rephrase prompt when nothing overrides it. */
export const DEFAULT_REPHRASE_TONE = "friendly and professional";

/**
 * Build the built-in rephrase system prompt for a given tone. Exported so the UI can show the EXACT
 * prompt that will run when nothing overrides it (AIPROMPT2 visibility) — no re-typed copy that could
 * drift from the runtime.
 */
export function defaultRephrasePrompt(tone: string = DEFAULT_REPHRASE_TONE): string {
  return `You rephrase messages to sound natural and varied while keeping the same meaning and intent. Tone: ${tone}. Reply with ONLY the rephrased message, nothing else. Keep it similar length. Do not add greetings or sign-offs unless the original has them.`;
}

/** The built-in default rephrase prompt (default tone) — the single source of truth the runtime uses. */
export const DEFAULT_REPHRASE_PROMPT = defaultRephrasePrompt();

/** A non-blank trimmed string, or `undefined` if unset/blank/whitespace-only. */
function nonBlank(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the rephrase system prompt by precedence (AIPROMPT option A):
 * per-rule custom prompt → per-workspace default → built-in default (with the given/default tone).
 * Blank / whitespace-only values are treated as unset. Mirrors `src/lib/ai/draft.ts`
 * `resolveDraftPrompt` (DRY). `tone` only steers the built-in default — a custom/workspace prompt is
 * used verbatim.
 */
export function resolveRephrasePrompt(args: {
  rulePrompt?: string | null;
  workspacePrompt?: string | null;
  tone?: string | null;
}): string {
  return (
    nonBlank(args.rulePrompt) ??
    nonBlank(args.workspacePrompt) ??
    defaultRephrasePrompt(nonBlank(args.tone) ?? DEFAULT_REPHRASE_TONE)
  );
}

export interface RephraseOptions {
  /** Full system-prompt override (per-rule). Wins over the workspace default + tone. */
  customPrompt?: string;
  /** Per-workspace default rephrase prompt. Used when no per-rule `customPrompt` is set. */
  workspacePrompt?: string | null;
  /** Desired tone — only applied to the built-in default (no custom/workspace prompt). */
  tone?: string;
}

/**
 * Rephrase a message to sound natural and varied while keeping its meaning. Provider-agnostic (any
 * OpenAI-compatible chat-completions endpoint, set via AI_BASE_URL + AI_MODEL). Best-effort: returns
 * the original text unchanged if no key is configured or the call fails. The system prompt is resolved
 * by `resolveRephrasePrompt` (rule → workspace → built-in default).
 */
export async function rephrase(workspaceId: string, baseText: string, opts: RephraseOptions = {}): Promise<string> {
  const systemContent = resolveRephrasePrompt({
    rulePrompt: opts.customPrompt,
    workspacePrompt: opts.workspacePrompt,
    tone: opts.tone,
  });

  const rephrased = await chatComplete({
    workspaceId,
    kind: "rephrase",
    system: systemContent,
    user: baseText,
    maxTokens: 300,
    temperature: 0.8,
  });

  return rephrased ?? baseText;
}
