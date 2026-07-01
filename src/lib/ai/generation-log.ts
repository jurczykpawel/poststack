import { sanitizeForLog, neutralizeHtml } from "@/lib/api/safe-log";

export interface GenerationLogEntry {
  workspaceId: string;
  kind: "draft" | "rephrase";
  model: string;
  system: string;
  user: string;
  /** The completion text, or `null` when the call failed / returned nothing usable. */
  response: string | null;
  /** A short failure reason (HTTP status, "empty completion", or the caught error message), or
   *  `null` on a successful non-empty completion. */
  error: string | null;
  durationMs: number;
  /** ADLOG2: the inbox conversation this call was made for, so the log panel can link straight to
   *  it. Absent for a call with no live conversation to attribute it to. */
  conversationId?: string;
}

/** Cap free-text fields so a very long comment/response can't bloat storage. */
const TEXT_CAP = 4000;

const safe = (value: string) => neutralizeHtml(sanitizeForLog(value)).slice(0, TEXT_CAP);

/**
 * ADLOG1: persist one row per `chatComplete` call — the exact request in, exact response out. The
 * lazy `@/lib/db` import keeps `client.ts` (and anything that transitively imports it) free of a
 * hard DB dependency at module-load time, mirroring `webhook-events/log.ts`'s `logWebhookMeta`.
 * Best-effort: a logging failure must never break the LLM call it's observing.
 */
export async function logGeneration(entry: GenerationLogEntry): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    const { aiGenerationLogs } = await import("@/db/schema");
    await db.insert(aiGenerationLogs).values({
      workspace_id: entry.workspaceId,
      kind: entry.kind,
      model: entry.model,
      system_prompt: safe(entry.system),
      user_message: safe(entry.user),
      response: entry.response != null ? safe(entry.response) : null,
      error: entry.error != null ? safe(entry.error) : null,
      duration_ms: entry.durationMs,
      conversation_id: entry.conversationId ?? null,
    });
  } catch {
    // best-effort — never break the caller
  }
}
