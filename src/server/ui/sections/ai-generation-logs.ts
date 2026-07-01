import { html } from "hono/html";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiGenerationLogs } from "@/db/schema";
import { icon } from "../components/icons";
import { timeAgo } from "../components/time";
import { proLink } from "../components/pro-link";

type Html = ReturnType<typeof html>;

export interface AiGenerationLogRow {
  id: string;
  kind: "draft" | "rephrase";
  model: string;
  systemPrompt: string;
  userMessage: string;
  response: string | null;
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

/** ADLOG1: the workspace's most recent AI generations (drafts + rephrases), newest first. */
export async function loadAiGenerationLogs(workspaceId: string, limit = 50): Promise<AiGenerationLogRow[]> {
  const rows = await db.query.aiGenerationLogs.findMany({
    where: eq(aiGenerationLogs.workspace_id, workspaceId),
    orderBy: [desc(aiGenerationLogs.created_at)],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    model: r.model,
    systemPrompt: r.system_prompt,
    userMessage: r.user_message,
    response: r.response,
    error: r.error,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));
}

/**
 * ADLOG1: read-only panel of recent AI generations — exact system/user sent, exact response or
 * failure reason, so "why did the model say that" never requires re-reading code. PRO-gated (same
 * features that can produce a generation: ai_draft / ai_rephrase).
 */
export function renderAiGenerationLogs(rows: AiGenerationLogRow[], canView: boolean, upgradeUrl: string): Html {
  if (!canView) {
    return html`<div class="callout">${icon("lock", "ico", 15)}<div>The AI generation log is a ${proLink(upgradeUrl, "PRO")} feature.</div></div>`;
  }
  if (rows.length === 0) {
    return html`<p class="muted" style="font-size:.85rem">No AI generations yet. Drafted replies and rephrased messages will appear here as they run.</p>`;
  }
  return html`<div class="ai-log-list">${rows.map((r) => {
    const ok = r.error === null;
    return html`<details class="card" style="margin:.5rem 0">
      <summary style="cursor:pointer;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
        <span class="badge tone-${ok ? "ok" : "bad"}">${ok ? "ok" : "failed"}</span>
        <span class="badge tone-neutral">${r.kind}</span>
        <span class="mono" style="font-size:.78rem">${r.model}</span>
        <span class="muted" style="font-size:.78rem">${r.durationMs}ms</span>
        <span class="muted" style="font-size:.78rem;margin-left:auto">${timeAgo(r.createdAt)}</span>
      </summary>
      <div style="margin-top:.5rem;display:grid;gap:.4rem;font-size:.82rem">
        <div><strong>System</strong><pre class="mono" style="white-space:pre-wrap;margin:.2rem 0">${r.systemPrompt}</pre></div>
        <div><strong>User</strong><pre class="mono" style="white-space:pre-wrap;margin:.2rem 0">${r.userMessage}</pre></div>
        ${r.response ? html`<div><strong>Response</strong><pre class="mono" style="white-space:pre-wrap;margin:.2rem 0">${r.response}</pre></div>` : html``}
        ${r.error ? html`<div><strong>Error</strong> <span style="color:var(--bad-text)">${r.error}</span></div>` : html``}
      </div>
    </details>`;
  })}</div>`;
}
