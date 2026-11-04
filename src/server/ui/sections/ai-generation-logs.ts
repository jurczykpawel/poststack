import { html } from "hono/html";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiGenerationLogs } from "@/db/schema";
import { containsPattern, countBy, listPage } from "@/lib/list-page";
import { isUuid } from "@/lib/api/identifiers";
import { dataList, readListState, type ListColumn } from "../components/data-list";
import { fmtCount, fmtDate, localTime } from "../components/format";
import { icon } from "../components/icons";
import { proLink } from "../components/pro-link";
import { timeAgo } from "../components/time";

/**
 * ADLOG1: every AI-drafted reply and rephrase, exactly as sent to and received from the model, so "why did the
 * model say that" never needs re-reading code. UXFLOW1 stage 3: it is the AI source of Activity (the shared
 * list) and Settings → Automation keeps only `renderAiLogSummary`. PRO-gated by the callers (ai_draft / ai_rephrase).
 */

const PAGE_SIZE = 50;

type Row = { id: string; kind: "draft" | "rephrase"; model: string; snippet: string | null; error: string | null; duration_ms: number; created_at: Date };

const resultExpr = sql<string>`case when ${aiGenerationLogs.error} is null then 'ok' else 'failed' end`;
const RESULTS = [{ value: "ok", label: "OK" }, { value: "failed", label: "Failed" }];
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const resultBadge = (error: string | null) => html`<span class="badge tone-${error === null ? "ok" : "bad"}">${error === null ? "ok" : "failed"}</span>`;

export function aiLogLocked(upgradeUrl: string) {
  return html`<div class="callout">${icon("lock", "ico", 15)}<div>The AI generation log is a ${proLink(upgradeUrl, "PRO")} feature.</div></div>`;
}

function detail(r: typeof aiGenerationLogs.$inferSelect) {
  const block = (label: string, text: string) => html`<p class="dl-label">${label}</p><pre class="dl-json">${text}</pre>`;
  return {
    title: html`${r.kind} · ${r.model}`,
    body: html`<dl class="dl-facts">
        <dt>Result</dt><dd>${resultBadge(r.error)}</dd>
        <dt>Duration</dt><dd>${seconds(r.duration_ms)}</dd>
        <dt>When</dt><dd>${localTime(r.created_at)}</dd>
        ${r.error ? html`<dt>Error</dt><dd class="dl-problem">${r.error}</dd>` : ""}
      </dl>
      ${block("System prompt", r.system_prompt)}${block("User message", r.user_message)}${r.response ? block("Response", r.response) : ""}
      ${r.conversation_id ? html`<a class="btn btn-secondary btn-sm dl-action" href="/inbox/${r.conversation_id}">Open conversation</a>` : ""}`,
  };
}

export async function renderAiLog(workspaceId: string, url: string, path: string) {
  const state = readListState(url, ["result", "kind", "model"], ["source"]);
  const scope = eq(aiGenerationLogs.workspace_id, workspaceId);
  const pat = containsPattern(state.q);
  const search = state.q
    ? sql`(${aiGenerationLogs.response} ILIKE ${pat} or ${aiGenerationLogs.error} ILIKE ${pat} or ${aiGenerationLogs.model} ILIKE ${pat} or ${aiGenerationLogs.user_message} ILIKE ${pat} or ${aiGenerationLogs.system_prompt} ILIKE ${pat})`
    : undefined;
  const f = state.filters;
  const kind = f.kind === "draft" || f.kind === "rephrase" ? eq(aiGenerationLogs.kind, f.kind) : undefined;
  const result = f.result === "ok" ? isNull(aiGenerationLogs.error) : f.result === "failed" ? isNotNull(aiGenerationLogs.error) : undefined;
  if (!result) delete f.result;
  const withoutResult = and(scope, search, kind, f.model ? eq(aiGenerationLogs.model, f.model) : undefined);

  const [page, resultCounts, models, opened] = await Promise.all([
    listPage<Row>({
      table: aiGenerationLogs, where: and(withoutResult, result), time: aiGenerationLogs.created_at, id: aiGenerationLogs.id,
      limit: PAGE_SIZE, after: state.after, before: state.before,
      keyOf: (r) => ({ at: r.created_at, id: r.id }),
      // The prompts can be long; the list only needs the start of the response.
      fetch: (q) => db.select({
        id: aiGenerationLogs.id, kind: aiGenerationLogs.kind, model: aiGenerationLogs.model, snippet: sql<string | null>`left(${aiGenerationLogs.response}, 160)`,
        error: aiGenerationLogs.error, duration_ms: aiGenerationLogs.duration_ms, created_at: aiGenerationLogs.created_at,
      }).from(aiGenerationLogs).where(q.where).orderBy(...q.orderBy).limit(q.limit),
    }),
    countBy(aiGenerationLogs, resultExpr, withoutResult),
    countBy(aiGenerationLogs, aiGenerationLogs.model, scope),
    isUuid(state.open) ? db.query.aiGenerationLogs.findFirst({ where: and(scope, eq(aiGenerationLogs.id, state.open)) }) : undefined,
  ]);

  const columns: ListColumn<Row>[] = [
    { label: "Response", width: "48%", main: true, cell: (r) => (r.error ? html`<span class="dl-problem">${r.error}</span>` : r.snippet ?? "—") },
    { label: "Kind", width: "11%", cell: (r) => html`<span class="badge tone-neutral">${r.kind}</span>` },
    { label: "Model", width: "18%", cell: (r) => html`<span class="mono">${r.model}</span>` },
    { label: "Time", width: "9%", num: true, cell: (r) => seconds(r.duration_ms) },
    { label: "When", width: "14%", cell: (r) => html`<span class="dl-when" data-local-title="${r.created_at.toISOString()}" title="${fmtDate(r.created_at)}">${timeAgo(r.created_at)}</span>` },
  ];

  return dataList<Row>({
    path, noun: "generations", state, searchPlaceholder: "Search prompt or response…",
    chips: {
      key: "result", label: "Result",
      all: [...resultCounts.values()].reduce((a, b) => a + b, 0),
      options: RESULTS.map((o) => ({ ...o, count: resultCounts.get(o.value) ?? 0 })),
    },
    selects: [
      { key: "kind", label: "Kind", options: [{ value: "draft", label: "Draft" }, { value: "rephrase", label: "Rephrase" }] },
      { key: "model", label: "Model", options: [...models.keys()].sort().map((m) => ({ value: m, label: m })) },
    ],
    columns, rows: page.rows, rowId: (r) => r.id,
    sub: (r) => html`${r.kind} · ${r.model} · ${timeAgo(r.created_at)}`,
    page,
    detail: opened ? detail(opened) : undefined,
    emptyTitle: "No AI generations yet",
    emptyBody: "Drafted replies and rephrased messages will appear here as they run.",
  });
}

/** Settings → Automation: a pointer to the log, with the numbers that tell whether to look. */
export async function renderAiLogSummary(workspaceId: string, canView: boolean, upgradeUrl: string) {
  if (!canView) return aiLogLocked(upgradeUrl);
  const [c] = await db.select({
    total: sql<number>`count(*)::int`,
    failed: sql<number>`count(*) filter (where ${aiGenerationLogs.error} is not null)::int`,
  }).from(aiGenerationLogs).where(and(eq(aiGenerationLogs.workspace_id, workspaceId), sql`${aiGenerationLogs.created_at} > now() - interval '7 days'`));
  const total = c?.total ?? 0;
  return html`<div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <p class="muted" style="margin:0;flex:1 1 220px">${total === 0 ? "No AI generations this week." : `${fmtCount(total)} generations, ${fmtCount(c!.failed)} failed this week.`}</p>
    <a class="btn btn-secondary btn-sm" href="/activity?source=ai">Open in Activity</a>
  </div>`;
}
