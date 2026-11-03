import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { AI_PROVIDER_IDS, PROVIDERS, type AiModel, type AiProviderId } from "@/lib/ai/providers";
import { listAiModels, saveAiSettings, testAiSettings, clearAiSettings, type AiSettingsView, type Candidate } from "@/lib/ai/settings";
import { requireInstanceOperator } from "../../../middleware/instance-operator";
import { settingsAuth, type Html } from "./shell";

// AIPROVIDER1: the "AI provider" form on /settings/integrations/ai. Server-rendered; the same functions as the
// REST API (src/lib/ai/settings.ts) do the work. Alpine only holds the form state and filters the model list.

const SUB: Record<AiProviderId, string> = { openai: "GPT", anthropic: "Claude", openrouter: "400+ models", groq: "Fast Llama", custom: "Ollama, LM Studio, any OpenAI-compatible" };
const ctx = (n?: number) => (n ? (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`) + " ctx" : "");
const notice = (tone: "ok" | "err" | "warn" | "info", body: Html | string) => html`<div class="notice notice-${tone}" role="${tone === "err" ? "alert" : "status"}">${body}</div>`;

export function aiProviderForm(v: AiSettingsView): Html {
  const presets = Object.fromEntries(PROVIDERS.map((p) => [p.id, { url: p.baseUrl, key: p.keyUrl ?? "", needKey: p.modelsNeedKey }]));
  const state = JSON.stringify({ provider: v.provider, baseUrl: v.provider === "custom" ? v.base_url : "", model: v.model, keySet: v.api_key.set, saved: v.provider, open: false, presets });
  const fromDb = v.sources.model === "db" || v.sources.provider === "db" || v.api_key.source === "db";
  return html`<form id="ai-form" class="ai-form" x-data="${state}" hx-post="/settings/integrations/ai/save" hx-ext="json-enc" hx-target="#int-grid" hx-swap="outerHTML">
    <p class="muted int-note">Your own key. Used by AI-drafted replies and rephrasing in every workspace on this instance. Stored encrypted.</p>
    <div class="int-step"><i>1</i><h3 id="ai-prov-label">Choose a provider</h3></div>
    <div class="prov" role="radiogroup" aria-labelledby="ai-prov-label">
      ${PROVIDERS.map((p) => html`<label><input type="radio" name="provider" value="${p.id}" x-model="provider" @change="$el.form.api_key.value = ''; $dispatch('reload-models')" />
        <b>${p.label.replace(" (OpenAI-compatible)", "").replace(" (Claude)", "")}</b><small>${SUB[p.id]}</small></label>`)}
    </div>
    <div class="int-step"><i>2</i><h3>Connect</h3></div>
    <div class="int-field" x-show="provider !== 'custom'">
      <span class="label">Base URL <span class="badge tone-neutral">set by provider</span></span>
      <div class="ai-ro"><code x-text="presets[provider].url"></code><button class="btn btn-ghost btn-sm" type="button" @click="baseUrl = presets[provider].url; provider = 'custom'">Change</button></div>
    </div>
    <div class="int-field" x-show="provider === 'custom'" x-cloak>
      <label class="label" for="ai-base-url">Base URL <span class="badge tone-info">custom</span></label>
      <input class="input" id="ai-base-url" name="base_url" type="url" x-model="baseUrl" placeholder="http://ollama:11434/v1" autocomplete="off" @change="$dispatch('reload-models')" />
      <div class="int-help">Any OpenAI-compatible endpoint, e.g. Ollama <code>http://ollama:11434/v1</code>. Changing the host requires entering the key again. Private and loopback addresses must be listed in <code>AI_ALLOWED_PRIVATE_TARGETS</code> on the server.</div>
    </div>
    <div class="int-field">
      <label class="label" for="ai-key">API key ${v.api_key.set ? html`<span class="badge tone-${v.api_key.source === "db" ? "ok" : "info"}" x-show="keySet && provider === saved">${v.api_key.source === "db" ? "set here" : "from env"}</span>` : ""}</label>
      <input class="input" id="ai-key" name="api_key" type="password" autocomplete="off" :placeholder="keySet && provider === saved ? '•••• set (paste to change)' : 'Paste your key'" @change="$dispatch('reload-models')" />
      <div class="int-help"><template x-if="presets[provider].key"><span>Get one at <a :href="presets[provider].key" target="_blank" rel="noopener" x-text="presets[provider].key"></a>. </span></template>Never shown again after saving.</div>
    </div>
    <div class="int-step"><i>3</i><h3><label for="ai-model">Model</label></h3></div>
    <div class="ai-combo">
      <input class="input" id="ai-model" name="model" role="combobox" aria-controls="ai-model-list" :aria-expanded="open" autocomplete="off" x-model="model"
        placeholder="Search models or type a model name" @focus="open = true" @input="open = true" @blur="setTimeout(() => open = false, 150)" @keydown.escape="open = false" required />
    </div>
    <div id="ai-models" hx-post="/settings/integrations/ai/models" hx-trigger="load, reload-models from:#ai-form" hx-swap="innerHTML"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn" type="button" hx-post="/settings/integrations/ai/test" hx-target="#ai-result" hx-swap="innerHTML">Test connection</button>
      <button class="btn btn-primary" type="submit">Save</button>
      ${fromDb ? html`<button class="btn btn-ghost" type="button" hx-post="/settings/integrations/ai/reset" hx-target="#int-grid" hx-swap="outerHTML" hx-confirm="Remove the values saved here and use the environment variables?">Use environment values</button>` : ""}
    </div>
    <div id="ai-result" role="status" aria-live="polite"></div>
  </form>`;
}

function modelList(models: AiModel[], list: { fetched_at: string; filtered_out: number }, all: boolean): Html {
  const time = new Date(list.fetched_at).toISOString().slice(11, 16);
  const ids = JSON.stringify({ ids: models.map((m) => m.id) });
  return html`<div x-data="${ids}"><div class="ai-list" id="ai-model-list" role="listbox" aria-label="Models" x-show="open" x-cloak>
    ${models.map((m) => html`<button type="button" class="ai-opt" role="option" data-id="${m.id}" data-s="${`${m.id} ${m.name ?? ""}`.toLowerCase()}"
      x-show="!model || $el.dataset.s.includes(model.toLowerCase())" @mousedown.prevent="model = $el.dataset.id; open = false">
      <span><span class="ai-id">${m.id}</span>${m.name ? html`<br /><span class="muted">${m.name}</span>` : ""}</span>
      <span class="ai-meta">${[ctx(m.context), m.price_in !== undefined ? `$${m.price_in}/1M in` : ""].filter(Boolean).join(" · ")}</span></button>`)}
    <div class="ai-opt ai-custom" x-show="model && !ids.includes(model)">Use custom name: <span class="ai-id" x-text="model"></span> <span class="muted">(not on the provider's list; checked when you test)</span></div>
  </div>
  <div class="ai-foot"><span>List from ${time} UTC · ${models.length} models${list.filtered_out ? ` · ${list.filtered_out} non-chat hidden` : ""}</span>
    <button class="btn btn-ghost btn-sm" type="button" hx-post="/settings/integrations/ai/models" hx-vals='{"refresh":"1"}' hx-target="#ai-models" hx-swap="innerHTML">Refresh</button>
    <label><input type="checkbox" name="all" value="1"${all ? raw(" checked") : ""} @change="$dispatch('reload-models')" /> Show all</label></div></div>`;
}

export function registerAiProvider(app: Hono, guard: MiddlewareHandler, renderGrid: (msg?: string) => Promise<Html>): void {
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (f: Record<string, unknown>, k: string) => (typeof f[k] === "string" ? (f[k] as string).trim() : "");
  const candidate = (f: Record<string, unknown>): Candidate => {
    const provider = AI_PROVIDER_IDS.find((p) => p === str(f, "provider"));
    return { provider, api_key: str(f, "api_key") || undefined, base_url: provider === "custom" ? str(f, "base_url") || undefined : undefined, model: str(f, "model") || undefined };
  };

  app.post("/settings/integrations/ai/models", guard, requireInstanceOperator, async (c) => {
    const f = await body(c);
    const all = f.all === "1";
    const r = await listAiModels(candidate(f), { refresh: f.refresh === "1", all });
    if (r.ok) return c.html(modelList(r.list.models, r.list, all));
    const needsKey = r.code === "invalid_key" && !str(f, "api_key");
    return c.html(needsKey ? html`<div class="ai-foot">Paste your key to load the model list, or type a model name above.</div>`
      : html`${notice("err", html`<b>${r.code}</b> · ${r.message}`)}<div class="ai-foot">You can still type a model name above.</div>`);
  });

  app.post("/settings/integrations/ai/test", guard, requireInstanceOperator, async (c) => {
    const r = await testAiSettings(candidate(await body(c)));
    if (!r.ok) return c.html(notice("err", html`<b>${r.code}</b> · ${r.message}`));
    const t = r.result;
    if (!t.ok) return c.html(notice("err", html`<b>${t.error.code}</b>${t.error.http_status ? ` · HTTP ${t.error.http_status}` : ""} · ${t.error.message}`));
    return c.html(notice("ok", html`✓ Works · <code>${t.model}</code> · ${t.latency_ms} ms${t.truncated ? " · the reply was cut off (reasoning models use the whole test budget), but the connection works" : ""}`));
  });

  app.post("/settings/integrations/ai/save", guard, requireInstanceOperator, async (c) => {
    const f = await body(c);
    const cand = candidate(f);
    const r = await saveAiSettings({ ...cand, model: cand.model ?? "", verify: f.verify !== "0" });
    if (!r.ok) {
      c.header("HX-Retarget", "#ai-result");
      c.header("HX-Reswap", "innerHTML");
      const providerSide = !/^[A-Z_]+$/.test(r.code);
      return c.html(html`${notice("err", html`Not saved. <b>${r.code}</b> · ${r.message}`)}${providerSide
        ? html`<div class="row"><button class="btn btn-sm" type="button" hx-post="/settings/integrations/ai/save" hx-vals='{"verify":"0"}' hx-target="#int-grid" hx-swap="outerHTML">Save anyway</button></div>` : ""}`);
    }
    const auth = await settingsAuth(c);
    if (auth) await recordAudit({ workspaceId: auth.workspaceId, actor: actorFromAuth(auth), action: AuditAction.AiSettingsUpdated, metadata: { provider: cand.provider, model: cand.model, key_changed: r.keyChanged } });
    return c.html(await renderGrid(`Saved. AI drafts and rephrasing now use ${cand.model} via ${PROVIDERS.find((p) => p.id === cand.provider)?.label ?? "your provider"}.`));
  });

  app.post("/settings/integrations/ai/reset", guard, requireInstanceOperator, async (c) => {
    await clearAiSettings();
    const auth = await settingsAuth(c);
    if (auth) await recordAudit({ workspaceId: auth.workspaceId, actor: actorFromAuth(auth), action: AuditAction.AiSettingsCleared });
    return c.html(await renderGrid("Reverted to the environment variables."));
  });
}
