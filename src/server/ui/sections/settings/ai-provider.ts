import { parseJsonBody } from "@/lib/api/body-limit";
import { localTime } from "../../components/format";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { ApiError } from "@/lib/api/response";
import { authenticateInstanceScope } from "@/lib/auth/instance-operator";
import { listProviders, migrateInstanceProviders } from "@/lib/ai/provider-store";
import { providerOperation } from "@/server/handlers/v1/settings/ai/providers/route";
import { PROVIDERS, type AiModel, type AiProviderId } from "@/lib/ai/providers";
import { type AiSettingsView } from "@/lib/ai/settings";
import { type Html } from "./shell";

// The dashboard and REST API share provider operations; Alpine holds only the connection form state.

const SUB: Record<AiProviderId, string> = { openai: "GPT", anthropic: "Claude", openrouter: "400+ models", groq: "Fast Llama", custom: "Ollama, LM Studio, any OpenAI-compatible" };
const ctx = (n?: number) => (n ? (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`) + " ctx" : "");
const notice = (tone: "ok" | "err" | "warn" | "info", body: Html | string) => html`<div class="notice notice-${tone}" role="${tone === "err" ? "alert" : "status"}">${body}</div>`;

export function aiProviderForm(v: AiSettingsView, id?: string): Html {
  const presets = Object.fromEntries(PROVIDERS.map((p) => [p.id, { url: p.baseUrl, key: p.keyUrl ?? "", needKey: p.modelsNeedKey }]));
  const state = JSON.stringify({ provider: v.provider, baseUrl: v.provider === "custom" ? v.base_url : "", model: v.model, keySet: v.api_key.set, saved: v.provider, open: false, presets });
  return html`<form id="ai-form" class="ai-form" x-data="${state}" hx-post="/settings/ai/providers/save" hx-ext="json-enc" hx-target="#ai-provider-list" hx-swap="outerHTML">
    ${id ? html`<input type="hidden" name="id" value="${id}" />` : ""}
    <p class="muted int-note">Your own key. Used for AI drafts and rephrasing. Never shown again after saving.</p>
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
        placeholder="Search models or type a model name" @focus="open = true; $dispatch('reload-models')" @input="open = true" @blur="setTimeout(() => open = false, 150)" @keydown.escape="open = false" required />
    </div>
    <div id="ai-models" hx-post="/settings/ai/providers/models" hx-target="this" hx-trigger="reload-models from:#ai-form" hx-swap="innerHTML"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn" type="button" hx-post="/settings/ai/providers/test" hx-target="#ai-result" hx-swap="innerHTML">Test connection</button>
      <button class="btn btn-primary" type="submit">${id ? "Save" : "Connect provider"}</button>

    </div>
    <div id="ai-result" role="status" aria-live="polite"></div>
  </form>`;
}

function modelList(models: AiModel[], list: { fetched_at: string; filtered_out: number }, all: boolean): Html {
  const time = localTime(new Date(list.fetched_at));
  const ids = JSON.stringify({ ids: models.map((m) => m.id) });
  return html`<div x-data="${ids}"><div class="ai-list" id="ai-model-list" role="listbox" aria-label="Models" x-show="open" x-cloak>
    ${models.map((m) => html`<button type="button" class="ai-opt" role="option" data-id="${m.id}" data-s="${`${m.id} ${m.name ?? ""}`.toLowerCase()}"
      x-show="!model || $el.dataset.s.includes(model.toLowerCase())" @mousedown.prevent="model = $el.dataset.id; open = false">
      <span><span class="ai-id">${m.id}</span>${m.name ? html`<br /><span class="muted">${m.name}</span>` : ""}</span>
      <span class="ai-meta">${[ctx(m.context), m.price_in !== undefined ? `$${m.price_in}/1M in` : ""].filter(Boolean).join(" · ")}</span></button>`)}
    <div class="ai-opt ai-custom" x-show="model && !ids.includes(model)">Use custom name: <span class="ai-id" x-text="model"></span> <span class="muted">(not on the provider's list; checked when you test)</span></div>
  </div>
  <div class="ai-foot"><span>List from ${time} · ${models.length} models${list.filtered_out ? ` · ${list.filtered_out} non-chat hidden` : ""}</span>
    <button class="btn btn-ghost btn-sm" type="button" hx-post="/settings/ai/providers/models" hx-vals='{"refresh":"1"}' hx-target="#ai-models" hx-swap="innerHTML">Refresh</button>
    <label><input type="checkbox" name="all" value="1"${all ? raw(" checked") : ""} @change="$dispatch('reload-models')" /> Show all</label></div></div>`;
}

export async function renderProviderList(scope: string | null, editId?: string, message?: string, connect = false): Promise<Html> {
  if (scope === null) await migrateInstanceProviders();
  const rows = await listProviders(scope), edit = rows.find(r => r.id === editId);
  const view: AiSettingsView = { configured: !!rows.length, provider: edit?.provider ?? "openai", base_url: edit?.base_url ?? "", model: edit?.model ?? "", api_key: { set: !!edit, source: edit ? "db" : "unset", hint: edit?.api_key_hint ?? null }, sources: { provider: "db", model: "db", base_url: "db" }, fallbacks: { count: 0 }, providers: [] };
  const ids = rows.map(r => r.id);
  const orderButton = (label: string, reordered: string[], disabled = false) => html`<button class="btn btn-ghost btn-sm" type="button" aria-label="${label}" title="${label}" ${disabled ? raw("disabled") : ""} hx-post="/settings/ai/providers/reorder" hx-vals="${JSON.stringify({ ids: reordered })}" hx-target="#ai-provider-list" hx-swap="outerHTML">${label === "Move up" ? "↑" : label === "Move down" ? "↓" : label}</button>`;
  return html`<section class="card set-card ai-providers" id="ai-provider-list" hx-ext="json-enc" x-data="${JSON.stringify({ connecting: connect || !!edit })}">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap"><h2>AI providers</h2><button class="btn btn-primary btn-sm" type="button" hx-get="/settings/ai/providers/connect" hx-target="#ai-provider-list" hx-swap="outerHTML">+ Connect provider</button></div>
    <p class="muted">Drafts and rephrasing use the main provider. If it fails, the next one in the list answers.</p>
    ${message ? notice("info", message) : ""}
    ${rows.length ? rows.map((r, i) => {
      const swap = (j: number) => { const copy = [...ids]; [copy[i], copy[j]] = [copy[j], copy[i]]; return copy; };
      return html`<div class="ai-provider-row" data-provider-id="${r.id}"><span class="ai-number ${i === 0 ? "main" : ""}">${i + 1}</span><div class="ai-provider-who"><b>${PROVIDERS.find(p => p.id === r.provider)?.label} ${i === 0 ? html`<span class="badge tone-info">Main</span>` : ""} ${r.answering_now ? html`<span class="badge tone-ok">Answering now</span>` : ""}</b><span class="muted">${r.model} · key …${r.api_key_hint}</span></div>
        <span class="badge tone-${r.last_test_status === "ok" ? "ok" : "warn"}">${r.last_test_status === "ok" ? "Tested" : r.last_test_status.replaceAll("_", " ")}${r.last_test_at ? html` · ${localTime(new Date(r.last_test_at), "clock")}` : ""}</span>
        <div class="ai-arrows">${orderButton("Move up", i > 0 ? swap(i - 1) : ids, i === 0)}${orderButton("Move down", i < rows.length - 1 ? swap(i + 1) : ids, i === rows.length - 1)}</div>
        <details class="ai-more"><summary class="btn btn-ghost btn-sm" aria-label="Actions for ${r.model}">⋯</summary><div class="ai-provider-menu">
          ${orderButton("Make main", [r.id, ...ids.filter(id => id !== r.id)], i === 0)}
          <button class="btn btn-ghost btn-sm" hx-get="/settings/ai/providers/edit/${r.id}" hx-target="#ai-provider-list" hx-swap="outerHTML">Edit</button>
          <button class="btn btn-ghost btn-sm" hx-post="/settings/ai/providers/test-again/${r.id}" hx-target="#ai-provider-list" hx-swap="outerHTML">Test again</button>
          <button class="btn btn-ghost btn-sm" hx-post="/settings/ai/providers/remove/${r.id}" hx-target="#ai-provider-list" hx-swap="outerHTML" hx-confirm="Remove this AI provider?" data-confirm-label="Remove">Remove</button>
        </div></details></div>`;
    }) : html`<p class="ai-provider-empty">No AI provider connected. ${scope === null ? "Environment settings apply when this list is empty." : "AI drafts and rephrasing are off."}</p>`}
    <details class="ai-advanced"><summary>Advanced: edit as JSON</summary><p class="muted">Same list and order. Omitted keys keep their saved values. New providers need api_key. Every change is tested.</p>
      <form hx-post="/settings/ai/providers/json" hx-ext="json-enc" hx-target="#ai-provider-list" hx-swap="outerHTML"><textarea class="input" name="providers" rows="6" aria-label="Provider JSON">${JSON.stringify(rows.map(r => ({ id: r.id, provider: r.provider, model: r.model, ...(r.provider === "custom" ? { base_url: r.base_url } : {}) })), null, 2)}</textarea><button class="btn btn-sm" type="submit">Apply JSON</button></form></details><div id="ai-list-result" role="status"></div>
    <dialog class="ai-provider-sheet" aria-label="${edit ? "Edit" : "Connect"} AI provider" x-effect="if(connecting && !$el.open) $el.showModal(); if(!connecting && $el.open) $el.close()" @close="connecting = false"><div class="row" style="justify-content:space-between"><h2>${edit ? "Edit" : "Connect"} AI provider</h2><button type="button" class="btn btn-ghost btn-sm" aria-label="Close" @click="connecting = false">×</button></div>${aiProviderForm(view, edit?.id)}</dialog>
  </section>`;
}

export function registerAiProvider(app: Hono, guard: MiddlewareHandler): void {
  const path = "/settings/ai/providers";
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const value: unknown = await parseJsonBody(c.req.raw, 65_536).catch(() => null);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  };
  const authScope = async (c: Context) => {
    const a = await authenticateInstanceScope(c.req.raw, "instance_ai:write");
    if (!a || a.authMethod !== "session") throw new ApiError("forbidden", "Sign in to manage AI providers", 403);
    return null;
  };
  app.get(`${path}/connect`, guard, async c => c.html(await renderProviderList(await authScope(c), undefined, undefined, true)));
  app.get(`${path}/edit/:id`, guard, async c => {
    const scope = await authScope(c);
    if (!(await listProviders(scope)).some(r => r.id === c.req.param("id"))) throw new ApiError("not_found", "Provider not found", 404);
    return c.html(await renderProviderList(scope, c.req.param("id")));
  });
  app.post(`${path}/json`, guard, async c => {
    const scope = await authScope(c);
    try {
      const fields = await body(c);
      const response = await providerOperation(new Request(c.req.url, { method: "PUT", headers: c.req.raw.headers, body: JSON.stringify({ providers: JSON.parse(typeof fields.providers === "string" ? fields.providers : "") }) }), "replace");
      const result = await response.json();
      if (result.error) { c.header("HX-Retarget", "#ai-list-result"); c.header("HX-Reswap", "innerHTML"); return c.html(notice("err", result.error.message)); }
      return c.html(await renderProviderList(scope, undefined, "Provider list saved"));
    } catch (e) { if (!(e instanceof SyntaxError) && !(e instanceof ApiError)) throw e; c.header("HX-Retarget", "#ai-list-result"); c.header("HX-Reswap", "innerHTML"); return c.html(notice("err", e instanceof ApiError ? e.message : "Invalid JSON. Nothing was saved.")); }
  });
  for (const action of ["save", "models", "test", "reorder"] as const) app.post(`${path}/${action}`, guard, async c => {
    const scope = await authScope(c), f = await body(c);
    const fields = Object.fromEntries(Object.entries(f).filter(([k, v]) => ["id", "provider", "base_url", "api_key", "model", "ids"].includes(k) && v !== ""));
    if (action === "models") Object.assign(fields, { refresh: f.refresh === "1", all: f.all === "1" });
    if (fields.provider !== "custom") delete fields.base_url;
    const id = typeof fields.id === "string" ? fields.id : undefined;
    if (action === "save") delete fields.id;
    try {
      const response = await providerOperation(new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: JSON.stringify(fields) }), action, action === "save" ? id : undefined);
      const result = await response.json();
      if (result.error) throw new ApiError(result.error.code, result.error.message, response.status);
      if (action === "models") return c.html(modelList(result.data.models, result.data, f.all === "1"));
      if (action === "test") return c.html(result.data.ok ? notice("ok", "Test passed") : notice("err", `Test failed: ${result.data.error.code}`));
      return c.html(await renderProviderList(scope));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      c.header("HX-Retarget", action === "models" ? "#ai-models" : action === "reorder" ? "#ai-list-result" : "#ai-result"); c.header("HX-Reswap", "innerHTML");
      return c.html(notice("err", e.message));
    }
  });
  for (const operation of ["remove", "test-again"] as const) app.post(`${path}/${operation}/:id`, guard, async c => {
    const scope = await authScope(c), action = operation === "remove" ? "remove" : "test";
    const response = await providerOperation(new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: "{}" }), action, c.req.param("id"));
    const result = await response.json();
    return c.html(await renderProviderList(scope, undefined, result.error?.message ?? (action === "test" ? result.data.ok ? "Test passed" : `Test failed: ${result.data.error.code}` : "Provider removed")));
  });
}
