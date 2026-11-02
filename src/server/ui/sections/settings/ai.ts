import type { Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workspaces } from "@/db/schema";
import { getInstanceLicense } from "@/lib/license/gate";
import { isInstanceOperator } from "@/lib/auth/instance-operator";
import { DEFAULT_REPHRASE_PROMPT } from "@/lib/ai/rephrase";
import { DEFAULT_DRAFT_PROMPT } from "@/lib/ai/draft";
import { isAiConfigured } from "@/lib/ai/client";
import { icon } from "../../components/icons";
import { proLink } from "../../components/pro-link";
import { aiUnconfiguredBanner } from "../../components/ai-notice";
import { renderAiLogSummary } from "../ai-generation-logs";
import { settingsAuth, settingsPage, type Html } from "./shell";

/**
 * AIDRAFT1 (Task 8): the workspace-default AI-draft prompt form (PRO). This default is used whenever a
 * channel has no per-channel prompt override; blank = the built-in default prompt. PRO-gated UI — a
 * free instance sees an upsell instead of the textarea (the POST is also gated server-side).
 */
function renderAiDraftPrompt(promptDm: string | null, promptPublic: string | null, canConfigure: boolean, upgradeUrl: string, msg?: string, aiConfigured = true): Html {
  const notice = msg ? html`<div class="notice notice-ok">${msg}</div>` : html``;
  if (!canConfigure) {
    return html`${notice}<div class="callout">${icon("lock", "ico", 15)}<div>A workspace-default AI-draft prompt is ${proLink(upgradeUrl, "PRO")}.</div></div>`;
  }
  // No provider key → the prompt is saved but nothing will run. Flag it where it's configured.
  const aiOff = aiConfigured ? html`` : aiUnconfiguredBanner("AI drafts");
  return html`${notice}${aiOff}
    <form hx-post="/settings/ai-draft-prompt" hx-ext="json-enc" hx-target="#ai-draft-prompt-area" hx-swap="innerHTML">
      <div class="set-cols">
      <label class="fld"><span>Direct messages <small>— used when a channel has no DM prompt override</small></span>
        <textarea name="ai_draft_prompt_dm" rows="4" maxlength="4000" placeholder="${DEFAULT_DRAFT_PROMPT}" style="font:inherit">${promptDm ?? ""}</textarea></label>
      <label class="fld"><span>Public comments <small>— used when a channel has no public comment prompt override</small></span>
        <textarea name="ai_draft_prompt_public" rows="4" maxlength="4000" placeholder="${DEFAULT_DRAFT_PROMPT}" style="font:inherit">${promptPublic ?? ""}</textarea></label>
      </div>
      <details class="muted" style="font-size:.78rem;margin:.4rem 0 0"><summary>Built-in default (used when blank)</summary><span class="mono">${DEFAULT_DRAFT_PROMPT}</span></details>
      <div class="row"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`;
}

/**
 * AIPROMPT1: the workspace-default rephrase prompt form (PRO). Used when a rule's `custom_prompt` is
 * blank; blank here = the built-in default rephrase prompt (shown as the textarea placeholder so the
 * operator always sees what will run if left empty — AIPROMPT2). PRO-gated UI + server-side gate.
 */
function renderAiRephrasePrompt(prompt: string | null, canConfigure: boolean, upgradeUrl: string, msg?: string, aiConfigured = true): Html {
  const notice = msg ? html`<div class="notice notice-ok">${msg}</div>` : html``;
  if (!canConfigure) {
    return html`${notice}<div class="callout">${icon("lock", "ico", 15)}<div>A workspace-default rephrase prompt is ${proLink(upgradeUrl, "PRO")}.</div></div>`;
  }
  const aiOff = aiConfigured ? html`` : aiUnconfiguredBanner("AI rephrasing");
  return html`${notice}${aiOff}
    <form hx-post="/settings/ai-rephrase-prompt" hx-ext="json-enc" hx-target="#ai-rephrase-prompt-area" hx-swap="innerHTML">
      <label class="fld"><span>Default prompt <small>— used when a rule has no custom prompt</small></span>
        <textarea name="ai_rephrase_prompt" rows="3" maxlength="4000" placeholder="${DEFAULT_REPHRASE_PROMPT}" style="font:inherit">${prompt ?? ""}</textarea></label>
      <details class="muted" style="font-size:.78rem;margin:.4rem 0 0"><summary>Built-in default (used when blank)</summary><span class="mono">${DEFAULT_REPHRASE_PROMPT}</span></details>
      <div class="row"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`;
}

const cardHead = (title: string, locked: boolean, upgradeUrl: string, lead: string) =>
  html`<div class="row" style="align-items:center;gap:.5rem"><h2 style="margin:0">${title}</h2>${locked ? proLink(upgradeUrl, "PRO") : html``}</div>
    <p class="muted" style="margin:.25rem 0 .75rem">${lead}</p>`;

export function registerAiSettings(app: Hono, guard: MiddlewareHandler): void {
  app.get("/settings/ai", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.redirect("/login");
    const [workspace, license, aiConfigured, operator] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, a.workspaceId), columns: { ai_draft_prompt_dm: true, ai_draft_prompt_public: true, ai_rephrase_prompt: true } }),
      getInstanceLicense(),
      isAiConfigured(),
      isInstanceOperator(a),
    ]);
    const canDraft = license.features.has("ai_draft");
    const canRephrase = license.features.has("ai_rephrase");
    const up = license.upgradeUrl;
    const provider = aiConfigured
      ? html`<span class="badge tone-ok">Provider connected</span>`
      : html`<span class="badge tone-neutral">No provider</span>`;
    return settingsPage(c, a, "/settings/ai", html`
      <div class="set-head">${provider}${operator ? html`<a class="btn btn-ghost btn-sm" href="/settings/integrations/ai">Provider settings</a>` : html``}</div>
      <section class="card set-card">
        ${cardHead("AI-drafted replies", !canDraft, up, "Default prompts. Each channel can override them, and turn drafting on, in its own settings.")}
        <div id="ai-draft-prompt-area">${renderAiDraftPrompt(workspace?.ai_draft_prompt_dm ?? null, workspace?.ai_draft_prompt_public ?? null, canDraft, up, undefined, aiConfigured)}</div>
      </section>
      <section class="card set-card">
        ${cardHead("Rephrasing", !canRephrase, up, "Used when a rule rewrites its reply for variety. A rule can set its own tone or prompt.")}
        <div id="ai-rephrase-prompt-area">${renderAiRephrasePrompt(workspace?.ai_rephrase_prompt ?? null, canRephrase, up, undefined, aiConfigured)}</div>
      </section>
      <section class="card set-card">
        ${cardHead("AI log", !(canDraft || canRephrase), up, "Every drafted reply and rephrase, with the full prompt and response or failure reason.")}
        ${await renderAiLogSummary(a.workspaceId, canDraft || canRephrase, up)}
      </section>`);
  });

  // AIDRAFT1 (Task 8): persist the workspace-default AI-draft prompt (PRO). Blank → null (built-in
  // default). Server-side PRO gate — a forged POST from a free instance is refused (403, no write).
  app.post("/settings/ai-draft-prompt", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const license = await getInstanceLicense();
    if (!license.features.has("ai_draft")) {
      return c.html(renderAiDraftPrompt(null, null, false, license.upgradeUrl), 403);
    }
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Cap at 4000 chars for parity with the per-channel prompt (channels/service.ts) — both feed the
    // same LLM prompt builder, so an unbounded workspace default must not slip past the channel cap.
    const rawDm = typeof form.ai_draft_prompt_dm === "string" ? form.ai_draft_prompt_dm.trim().slice(0, 4000) : "";
    const rawPublic = typeof form.ai_draft_prompt_public === "string" ? form.ai_draft_prompt_public.trim().slice(0, 4000) : "";
    await db.update(workspaces).set({ ai_draft_prompt_dm: rawDm || null, ai_draft_prompt_public: rawPublic || null }).where(eq(workspaces.id, a.workspaceId));
    return c.html(renderAiDraftPrompt(rawDm || null, rawPublic || null, true, license.upgradeUrl, "Default AI-draft prompt saved.", await isAiConfigured()));
  });

  // AIPROMPT1: persist the workspace-default rephrase prompt (PRO). Blank → null (built-in default).
  // Server-side PRO gate — a forged POST from a free instance is refused (403, no write).
  app.post("/settings/ai-rephrase-prompt", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const license = await getInstanceLicense();
    if (!license.features.has("ai_rephrase")) {
      return c.html(renderAiRephrasePrompt(null, false, license.upgradeUrl), 403);
    }
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Cap at 4000 (parity with the AI-draft prompt + the per-rule custom_prompt 2000 is the override).
    const raw = typeof form.ai_rephrase_prompt === "string" ? form.ai_rephrase_prompt.trim().slice(0, 4000) : "";
    await db.update(workspaces).set({ ai_rephrase_prompt: raw || null }).where(eq(workspaces.id, a.workspaceId));
    return c.html(renderAiRephrasePrompt(raw || null, true, license.upgradeUrl, "Default rephrase prompt saved.", await isAiConfigured()));
  });
}
