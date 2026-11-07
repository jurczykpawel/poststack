import { listProviders as listAiProviders } from "@/lib/ai/provider-store";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { env } from "@/lib/env";
import { brandingSchema } from "@/lib/brand";
import { isInstanceOperator } from "@/lib/auth/instance-operator";
import { getInstanceLicense, requireFeature, ProRequiredError } from "@/lib/license/gate";
import { configStatus, setConfig, setConfigs, clearConfig, type ConfigStatus } from "@/lib/settings/config";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/settings/registry";
import { webhookUrlError } from "@/lib/webhooks/safe-target";
import { listProviders } from "@/lib/providers";
import { requireInstanceOperator } from "../../../middleware/instance-operator";
import { brandingForm } from "../../branding";
import { renderProviderList, registerAiProvider } from "./ai-provider";
import { copyBtn } from "../../components/copy";
import { platformGlyph } from "../../components/platform";
import { dot, type Tone } from "../../components/status";
import { settingsAuth, settingsPage, managedByOperator, type Html } from "./shell";

/** One integration as the operator thinks of it: what to paste at the provider, which keys to enter
 *  here (registry-backed, stored encrypted), and which ones only the server environment can set. */
interface Service {
  id: string;
  name: string;
  sub: string;
  group: "Channels" | "Other";
  platform?: string;
  where?: string;
  urls?: ReadonlyArray<readonly [string, string]>;
  /** Keys editable here; `required` decides the state shown in the list. */
  keys?: readonly ConfigKey[];
  required?: readonly ConfigKey[];
  /** Direct-OAuth publishers read credentials from the environment only (provider id + var names). */
  envProvider?: { id: string; label: string; vars: readonly string[] };
  branding?: true;
  /** The AI provider has its own form (provider picker + model list) instead of generic key fields. */
  ai?: true;
}

const SERVICES: readonly Service[] = [
  { id: "meta", name: "Meta", sub: "Facebook & Instagram", group: "Channels", platform: "facebook", where: "developers.facebook.com/apps",
    urls: [["OAuth redirect (Facebook Login → Settings)", "/api/oauth/facebook/callback"], ["OAuth redirect (Instagram)", "/api/oauth/instagram/callback"],
      ["OAuth redirect (Instagram Business Login → API setup with Instagram login)", "/api/oauth/instagram-login/callback"], ["Webhook callback (Messenger + Instagram products)", "/api/webhooks/meta"]],
    keys: ["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"], required: ["META_APP_ID", "META_APP_SECRET"] },
  { id: "google", name: "Google", sub: "YouTube & Gmail", group: "Channels", platform: "youtube", where: "Google Cloud Console → Credentials",
    urls: [["Authorized redirect URI (YouTube)", "/api/oauth/youtube/callback"], ["Authorized redirect URI (Gmail)", "/api/oauth/gmail/callback"]],
    keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], required: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    envProvider: { id: "youtube", label: "YouTube direct publishing", vars: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"] } },
  { id: "tiktok", name: "TikTok", sub: "Publishing", group: "Channels", platform: "tiktok", where: "developers.tiktok.com → Login Kit",
    urls: [["Redirect URI", "/api/oauth/connect/tiktok/callback"]], keys: ["TIKTOK_CONFIRM_AT_SEND"],
    envProvider: { id: "tiktok", label: "TikTok publishing", vars: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] } },
  { id: "linkedin", name: "LinkedIn", sub: "Publishing", group: "Channels", platform: "linkedin", where: "LinkedIn Developers → Auth → Authorized redirect URLs",
    urls: [["Authorized redirect URL", "/api/oauth/connect/linkedin/callback"]], envProvider: { id: "linkedin", label: "LinkedIn publishing", vars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"] } },
  { id: "x", name: "X", sub: "Publishing", group: "Channels", platform: "x", where: "X developer portal → User authentication settings",
    urls: [["Callback URI", "/api/oauth/connect/x/callback"]], envProvider: { id: "x", label: "X publishing", vars: ["X_CLIENT_ID", "X_CLIENT_SECRET"] } },
  { id: "threads", name: "Threads", sub: "Publishing", group: "Channels", platform: "threads", where: "developers.facebook.com → Threads app → Redirect Callback URLs",
    urls: [["Redirect callback URL", "/api/oauth/connect/threads/callback"]], envProvider: { id: "threads", label: "Threads publishing", vars: ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"] } },
  { id: "ai", name: "AI provider", sub: "Drafts and rephrasing", group: "Other", ai: true, keys: [], required: ["AI_API_KEY"] },
  { id: "reelstack", name: "ReelStack", sub: "Inbound media webhook", group: "Other", keys: ["REELSTACK_WEBHOOK_SECRET"], required: ["REELSTACK_WEBHOOK_SECRET"] },
  { id: "security", name: "Login protection", sub: "Proof-of-work captcha", group: "Other", keys: ["ALTCHA_HMAC_KEY"], required: ["ALTCHA_HMAC_KEY"] },
  { id: "branding", name: "Instance branding", sub: "Name, logo and footer", group: "Other", branding: true },
];

type State = { tone: Tone; label: string; via?: string };

/** Where the effective values come from, in the operator's words ("via Settings + environment"). */
function via(sources: ConfigStatus["source"][]): string | undefined {
  const db = sources.includes("db"), envSet = sources.includes("env");
  return db || envSet ? (db && envSet ? "Settings + environment" : db ? "Settings" : "environment") : undefined;
}
const envProviderReady = (s: Service) => listProviders().find((p) => p.id === s.envProvider?.id)?.oauthConfig?.() != null;

function stateOf(s: Service, status: ConfigStatus[], whiteLabel: boolean): State {
  if (s.branding) {
    if (!whiteLabel) return { tone: "neutral", label: "Locked" };
    return status.find((f) => f.key === "INSTANCE_BRANDING")?.source === "db" ? { tone: "ok", label: "Customised" } : { tone: "neutral", label: "Default" };
  }
  const req = (s.required ?? []).map((k) => status.find((f) => f.key === k)?.source ?? "unset");
  if (req.length) {
    const set = req.filter((x) => x !== "unset").length;
    return set === req.length ? { tone: "ok", label: "Set up", via: via(req) } : set ? { tone: "warn", label: "Partly set", via: via(req) } : { tone: "neutral", label: "Not set" };
  }
  if (s.envProvider) {
    if (envProviderReady(s)) return { tone: "ok", label: "Set up", via: "environment" };
    return s.envProvider.vars.some((v) => process.env[v]) ? { tone: "warn", label: "Partly set", via: "environment" } : { tone: "neutral", label: "Not set" };
  }
  return { tone: "neutral", label: "Not set" };
}

const sourceBadge = (src: ConfigStatus["source"]) =>
  src === "db" ? html`<span class="badge tone-ok">set here</span>`
  : src === "env" ? html`<span class="badge tone-info">from env</span>`
  : html`<span class="badge tone-neutral">not set</span>`;

function field(f: ConfigStatus): Html {
  const input = f.key === "TIKTOK_CONFIRM_AT_SEND"
    ? html`<select class="input" id="cf-${f.key}" name="${f.key}">
        <option value="false"${f.preview !== "true" ? raw(" selected") : ""}>Off — automatic after validation</option>
        <option value="true"${f.preview === "true" ? raw(" selected") : ""}>On — always confirm at send time</option></select>`
    : html`<input class="input" id="cf-${f.key}" name="${f.key}" type="${f.secret ? "password" : "text"}" autocomplete="off"
        placeholder="${f.secret ? (f.source === "unset" ? "Paste value" : "Paste to change") : f.preview || "Paste value"}" />`;
  return html`<div class="int-field">
    <label class="label" for="cf-${f.key}">${f.label} ${sourceBadge(f.source)}</label>
    ${input}
    <div class="int-help"><code>${f.key}</code>${f.help ? html` · ${f.help}` : ""}</div>
    ${f.source === "db" ? html`<button class="btn btn-ghost btn-sm" type="submit" name="clear" value="${f.key}" formnovalidate title="Remove the value stored here">Use environment value</button>` : ""}
  </div>`;
}

async function detail(s: Service, status: ConfigStatus[], whiteLabel: boolean, msg?: string): Promise<Html> {
  const st = stateOf(s, status, whiteLabel);
  let n = 0;
  const step = (title: Html | string) => html`<div class="int-step"><i>${++n}</i><h3>${title}</h3></div>`;
  const fields = (s.keys ?? []).map((k) => status.find((f) => f.key === k)).filter((f): f is ConfigStatus => !!f);
  return html`<div class="card int-detail" id="int-detail">
    <a class="int-back" href="/settings/integrations">← All integrations</a>
    <div class="int-detail-head"><h2>${s.name}</h2><span class="muted">${s.sub}</span><span class="int-state">${dot(st.tone)} ${st.label}${st.via ? ` via ${st.via}` : ""}</span></div>
    ${msg ? html`<div class="notice notice-ok" role="status">${msg}</div>` : ""}
    ${s.branding ? (whiteLabel ? brandingForm() : html`<p class="muted">A Business license enables custom branding.</p><p class="muted">Custom name, logo and footer across the whole installation.</p>`) : ""}
    ${s.urls ? html`${step(html`Paste these into ${s.where}`)}${s.urls.map(([label, path]) => html`<div class="int-url-label">${label}</div>
      <div class="int-url"><code>${env.APP_URL}${path}</code>${copyBtn(`${env.APP_URL}${path}`)}</div>`)}` : ""}
    ${s.ai ? await renderProviderList(null) : ""}
    ${fields.length ? html`${step("Enter your keys")}
      <form hx-post="/settings/integrations/${s.id}" hx-ext="json-enc" hx-target="#int-grid" hx-swap="outerHTML">
        <p class="muted int-note">Stored encrypted. A value set here overrides the environment variable. Leave a field blank to keep it.</p>
        <div class="int-fields">${fields.map(field)}</div>
        <div class="row" style="margin-top:12px"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>` : ""}
    ${s.envProvider ? html`${step(s.required ? `${s.envProvider.label}: set keys on the server` : "Set keys on the server")}
      <p class="muted int-note">${s.envProvider.label} reads its credentials from environment variables:
        ${s.envProvider.vars.map((v, i) => html`${i ? ", " : ""}<code>${v}</code>`)}.
        ${envProviderReady(s) ? html`<strong>Both are set.</strong>` : "Not set yet; restart the server after adding them."}</p>` : ""}
  </div>`;
}

function list(current: string | undefined, status: ConfigStatus[], whiteLabel: boolean): Html {
  const row = (s: Service) => {
    const st = stateOf(s, status, whiteLabel);
    return html`<a class="int-item" href="/settings/integrations/${s.id}"${s.id === current ? raw(' aria-current="page"') : ""}>
      ${s.platform ? platformGlyph(s.platform) : html`<span class="int-glyph" aria-hidden="true">${s.name.charAt(0)}</span>`}
      <span class="int-text"><span class="int-name">${s.name}</span><span class="muted int-sub">${s.sub}</span></span>
      <span class="int-state">${dot(st.tone)} ${st.label}</span></a>`;
  };
  return html`<nav class="int-list" aria-label="Integrations">
    ${(["Channels", "Other"] as const).map((g) => html`<div class="int-group">${g}</div>${SERVICES.filter((s) => s.group === g).map(row)}`)}
  </nav>`;
}

async function grid(current: Service | undefined, msg?: string): Promise<Html> {
  const [rawStatus, license, providers] = await Promise.all([configStatus(), getInstanceLicense(), listAiProviders(null)]);
  const status = rawStatus.map(f => f.key === "AI_API_KEY" && providers.length ? { ...f, source: "db" as const } : f);
  const whiteLabel = license.features.has("white_label");
  const shown = current ?? SERVICES[0];
  return html`<div class="int-grid${current ? " has-current" : ""}" id="int-grid">${list(current?.id, status, whiteLabel)}${await detail(shown, status, whiteLabel, msg)}</div>`;
}

async function integrationsPage(c: Context): Promise<Response> {
  const a = await settingsAuth(c);
  if (!a) return c.redirect("/login");
  const id = c.req.param("service");
  const service = id ? SERVICES.find((s) => s.id === id) : undefined;
  if (id && !service) return c.text("Not found", 404);
  if (!(await isInstanceOperator(a))) return settingsPage(c, a, "/settings/integrations", managedByOperator);
  return settingsPage(c, a, "/settings/integrations", await grid(service));
}

export function registerIntegrationSettings(app: Hono, guard: MiddlewareHandler): void {
  app.get("/settings/integrations", guard, integrationsPage);
  registerAiProvider(app, guard);
  app.get("/settings/integrations/:service", guard, requireInstanceOperator, integrationsPage);

  // One integration's keys in one request: blank fields stay as they are; a "Use environment value"
  // button clears just that key. Only the service's own keys are accepted.
  app.post("/settings/integrations/:service", guard, requireInstanceOperator, async (c) => {
    const service = SERVICES.find((s) => s.id === c.req.param("service"));
    if (!service?.keys) return c.text("Not found", 404);
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const own = new Set<string>(service.keys);
    if (typeof form.clear === "string" && own.has(form.clear)) {
      await clearConfig(form.clear as ConfigKey);
      return c.html(await grid(service, "Reverted to the environment variable."));
    }
    const status = await configStatus();
    const entries = service.keys
      .map((k) => [k, typeof form[k] === "string" ? (form[k] as string).trim() : ""] as const)
      // An unchanged select (TikTok confirmation) is not a change; a blank field keeps its value.
      .filter(([k, v]) => v && !(k === "TIKTOK_CONFIRM_AT_SEND" && v === (status.find((f) => f.key === k)?.preview || "false")));
    if (entries.some(([k, v]) => k === "TIKTOK_CONFIRM_AT_SEND" && !["true", "false"].includes(v))) return c.text("Choose On or Off for TikTok confirmation.", 422);
    const alertUrl = entries.find(([k]) => k === "CHANNEL_ALERT_WEBHOOK_URL")?.[1];
    const badAlert = alertUrl ? await webhookUrlError(alertUrl) : null;
    if (badAlert) return c.text(`Alert webhook URL rejected: ${badAlert}. Use a public http(s) address.`, 422);
    if (entries.length) await setConfigs(entries);
    return c.html(await grid(service, entries.length ? `Saved ${entries.length} value${entries.length === 1 ? "" : "s"}.` : "Nothing changed. Enter a value to save it."));
  });

  // CONFIG1: set / clear one instance credential (stored encrypted; overrides the env var). Kept for
  // the Problem alerts fallback card and API-style callers; the Integrations page saves per group.
  app.post("/settings/credentials", guard, requireInstanceOperator, async (c) => {
    const form = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const key = typeof form.key === "string" ? form.key : "";
    if (key === "INSTANCE_BRANDING") return c.text("Use instance branding settings.", 400);
    if (!CONFIG_KEYS.has(key)) return c.html(html`<span class="error">Unknown setting.</span>`, 400);
    // The saved AI key must never follow a changed provider/URL: those are edited only through the AI provider form.
    if (["AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER", "AI_FALLBACKS"].includes(key)) return c.text("Use the AI provider form.", 400);
    if (form.clear === "1" || form.clear === true) {
      await clearConfig(key as ConfigKey);
      return c.html(html`Reverted to the environment variable.`);
    }
    const value = typeof form.value === "string" ? form.value.trim() : "";
    // Empty save = no-op (don't silently wipe a secret); use Clear to revert.
    if (!value) return c.html(html`Nothing changed — enter a value, or use Clear to revert to env.`);
    if (key === "TIKTOK_CONFIRM_AT_SEND" && !["true", "false"].includes(value)) return c.html(html`Choose On or Off for TikTok confirmation.`, 422);
    if (key === "CHANNEL_ALERT_WEBHOOK_URL") {
      const bad = await webhookUrlError(value);
      if (bad) return c.html(html`<span class="error">Alert webhook URL rejected: ${bad}. Use a public http(s) address.</span>`, 422);
    }
    await setConfig(key as ConfigKey, value);
    return c.html(html`Saved.`);
  });

  app.post("/settings/branding", guard, requireInstanceOperator, async (c) => {
    try {
      await requireFeature("white_label");
    } catch (error) {
      if (!(error instanceof ProRequiredError)) throw error;
      return c.json({ data: null, error: { code: "pro_required", message: error.message } }, 403);
    }
    const input = await c.req.json().catch(() => null);
    if (input && typeof input === "object" && Object.keys(input).length === 1 && input.reset === true) {
      await clearConfig("INSTANCE_BRANDING");
      c.header("HX-Refresh", "true");
      return c.html(html`Stored instance branding cleared.`);
    }
    const parsed = brandingSchema.safeParse(input);
    if (!parsed.success) {
      if (c.req.header("hx-request") === "true") {
        return c.html(html`<span class="error" role="alert">Check the brand fields.
          ${parsed.error.issues.map((issue) => html`<span style="display:block">${issue.path.join(".") || "Branding"}: ${issue.message}</span>`)}</span>`, 400);
      }
      return c.json({ data: null, error: { code: "invalid_request", message: "Check the brand fields.", details: parsed.error.issues } }, 400);
    }
    await setConfig("INSTANCE_BRANDING", JSON.stringify(parsed.data));
    c.header("HX-Refresh", "true");
    return c.html(html`Instance branding saved.`);
  });
}
