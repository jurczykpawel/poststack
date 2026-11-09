import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { authenticate, authenticateSession } from "@/lib/auth";
import { ApiError, apiErrorResponse } from "@/lib/api/response";
import { listBrands } from "@/lib/brands/service";
import { t } from "@/lib/i18n";
import { getInsightsConnector } from "@/lib/insights/catalog";
import { beginInsightConsent } from "@/lib/insights/consent";
import { getInsightStatus, type AccountReport, type InsightStatus } from "@/lib/insights/service";
import type { ChannelRef } from "@/lib/insights/types";
import { getInstanceLicense } from "@/lib/license/gate";
import { platform as platformEnum, type Platform } from "@/db/schema";
import * as insightsApi from "@/server/handlers/v1/channels/[channelId]/insights/route";
import * as refreshApi from "@/server/handlers/v1/channels/[channelId]/insights/refresh/route";
import { localTime } from "../components/format";
import { dashboardDoc } from "../layout";
import { formatMetricValue, insightsChart } from "./insights-chart";
import { INSIGHT_RANGES, insightPlatforms, insightsHref, loadInsightsPage, readInsightsQuery, type InsightChannelOption, type InsightsQuery } from "./insights-data";

type Html = ReturnType<typeof html>;
type Tone = "info" | "warn";
type Report = AccountReport;
type ReportMetric = Report["catalog"][number];

const PATH = "/insights";
const POLL_LIMIT = 12;
const HOUR = 3600000;
/** Fixed notices a redirect may carry back to the page; anything else is ignored. */
const NOTICES: Record<string, { tone: "err" | "ok" | "info"; text: string }> = {
  credential_required: { tone: "err", text: "Connect an Instagram Business Login or a Meta User managed connection first. A Page token cannot provide account Insights." },
  not_configured: { tone: "err", text: "The login for this channel is not configured on this instance. Set up the app credentials in Settings first." },
  consent_failed: { tone: "err", text: "Access could not be requested. Try again from this page." },
  refresh_queued: { tone: "ok", text: "Refresh queued. New data appears after the worker finishes." },
  refresh_later: { tone: "info", text: "A refresh was requested recently. Try again later." },
};

const hxNav = html`hx-get="${PATH}" hx-target="#insights-root" hx-swap="outerHTML" hx-push-url="true"`;
const hidden = (q: InsightsQuery, omit: Array<keyof InsightsQuery> = []) => (["brand", "channel", "range", "metric"] as const)
  .filter((k) => !omit.includes(k) && q[k] !== "")
  .map((k) => html`<input type="hidden" name="${k}" value="${String(q[k])}" />`);

function stateCard(tone: Tone, title: string, body: Html | string, action: Html | string = ""): Html {
  return html`<section class="ins-state${tone === "warn" ? " ins-state-warn" : ""}" role="status"><h2>${title}</h2><p>${body}</p>${action}</section>`;
}

const consentForm = (channelId: string, label: string) => html`<form method="post" action="${PATH}/consent">
    <input type="hidden" name="channel" value="${channelId}" />
    <button type="submit" class="btn btn-primary">${label}</button></form>`;

/** "worker delayed": no success for 48 h, or a first sync attempt without progress for 15 min. */
export function workerDelayed(status: InsightStatus, now = Date.now()): boolean {
  if (status.collectionMode !== "on" || status.reason === "channel_paused" || status.displayStatus === "additional_access_required") return false;
  if (status.lastSuccessfulSyncAt) return now - Date.parse(status.lastSuccessfulSyncAt) > 48 * HOUR;
  return !!status.lastAttemptAt && now - Date.parse(status.lastAttemptAt) > 15 * 60000;
}

/** The access/collection state as one message with its action; null when data can be shown as is. */
function accessState(status: InsightStatus, report: Report, channel: InsightChannelOption, q: InsightsQuery): Html | null {
  const id = status.channelId;
  if (status.collectionMode === "off") {
    const metrics = report.catalog.filter((m) => m.active).map((m) => m.label).join(", ");
    const retained = report.series.length > 0;
    return stateCard("info", t("insights.off.title", { channel: channel.label.split(" · ").slice(1).join(" · ") || channel.label }),
      html`${t("insights.off.body", { metrics })} ${t("insights.off.note")}${retained ? html`<br />${t("insights.off.retained")}` : ""}`,
      html`<form method="post" action="${PATH}/collection" hx-post="${PATH}/collection" hx-target="#insights-root" hx-swap="outerHTML">
        <input type="hidden" name="channel" value="${id}" /><input type="hidden" name="mode" value="on" />${hidden(q, ["channel", "metric"])}
        <button type="submit" class="btn btn-primary">Turn on Insights</button></form>`);
  }
  if (status.reason === "channel_paused") return stateCard("warn", t("insights.paused.title"), t("insights.paused.body"), html`<a class="btn btn-secondary" href="/channels/${id}">Open channel</a>`);
  if (status.displayStatus === "additional_access_required") {
    if (status.state === "unsupported") return stateCard("warn", t("insights.unsupported.title"), t("insights.unsupported.body"), html`<a class="btn btn-secondary" href="/channels">Go to Channels</a>`);
    if (status.state === "needs_reauth") return stateCard("warn", t("insights.reauth.title"), t("insights.reauth.body"), consentForm(id, "Sign in again"));
    const missing = status.missingPermissions.length ? html`<ul class="ins-perms">${status.missingPermissions.map((p) => html`<li><code>${p}</code></li>`)}</ul>` : "";
    return stateCard("warn", t("insights.permission.title"), html`${t("insights.permission.body")} ${t("insights.permission.declined")}${missing}`, consentForm(id, "Grant Insights access"));
  }
  if (status.displayStatus === "checking" && !report.series.length && !status.lastSuccessfulSyncAt && !workerDelayed(status)) return stateCard("info", t("insights.checking.title"), t("insights.checking.body"));
  return null;
}

/** Banners that accompany data: provider limits/outage and a delayed worker. */
function freshnessBanners(status: InsightStatus): Html {
  const at = status.lastSuccessfulSyncAt ? localTime(new Date(status.lastSuccessfulSyncAt)) : html`${t("insights.sync.never").toLowerCase()}`;
  const next = status.nextRetryAt && Date.parse(status.nextRetryAt) > Date.now() ? localTime(new Date(status.nextRetryAt)) : null;
  const out: Html[] = [];
  if (next && (status.reason === "rate_limited" || status.reason === "provider_unavailable")) {
    const body = status.reason === "rate_limited" ? "insights.limited.body" : "insights.unavailable.body";
    const [before, after] = t(body, { next: "\u0000" }).split("\u0000");
    const [titleBefore, titleAfter] = t("insights.limited.title", { at: "\u0000" }).split("\u0000");
    out.push(stateCard("warn", "", html`<strong>${titleBefore}${at}${titleAfter}</strong><br />${before}${next}${after}`));
  }
  if (workerDelayed(status)) out.push(stateCard("warn", t("insights.delayed.title"), t("insights.delayed.body")));
  return html`${out}`;
}

function comparisonText(percent: string, range: number): Html {
  const n = Math.round(Number(percent) * 10) / 10;
  const tone = n > 0 ? "up" : n < 0 ? "down" : "flat";
  return html`<span class="ins-card-d ins-${tone}">${n > 0 ? "+" : ""}${n}% vs previous ${range} days</span>`;
}

function card(metric: ReportMetric, report: Report, q: InsightsQuery, selected: string): Html {
  const summary = report.summary.find((s) => s.metricKey === metric.key);
  const value = summary?.value ?? null;
  let note: Html;
  if (value === null) note = html`<span class="ins-card-d">${summary?.reason === "unique_range_unavailable" ? t("insights.uniqueTotal") : t("insights.incomplete")}</span>`;
  else if (summary?.comparisonPercent) note = comparisonText(summary.comparisonPercent, q.range);
  else if (metric.aggregation === "latest_snapshot") note = html`<span class="ins-card-d">Latest reading</span>`;
  else note = html`<span class="ins-card-d">${t("insights.noComparison")}</span>`;
  const label = metric.aggregation === "unique_range" ? html`${metric.label} <span class="ins-card-q">(unique, range)</span>` : metric.label;
  const body = html`<small class="ins-card-l">${label}</small><b class="ins-card-v">${value === null ? "—" : formatMetricValue(metric, value)}</b>${note}`;
  if (!metric.chartable) return html`<div class="ins-card">${body}</div>`;
  return html`<form method="get" action="${PATH}" ${hxNav}>${hidden(q, ["metric"])}
    <button type="submit" class="ins-card" name="metric" value="${metric.key}" aria-pressed="${metric.key === selected ? "true" : "false"}">${body}</button></form>`;
}

function dataView(report: Report, q: InsightsQuery): Html {
  const cards = report.catalog.filter((m) => m.active && m.cardOrder !== null).sort((a, b) => a.cardOrder! - b.cardOrder!);
  const chartable = cards.filter((m) => m.chartable);
  const metric = chartable.find((m) => m.key === q.metric) ?? chartable[0];
  const inactive = report.catalog.filter((m) => !m.active).map((m) => m.label);
  const hasRows = report.series.some((o) => o.value !== null);
  return html`${hasRows ? "" : stateCard("info", t("insights.empty.title"), t("insights.empty.body"))}
    <div class="ins-cards">${cards.map((m) => card(m, report, q, metric?.key ?? ""))}</div>
    ${inactive.length ? html`<p class="ins-note">${t("insights.inactive", { metrics: inactive.join(", ") })}</p>` : ""}
    ${metric ? html`<section class="panel ins-panel">
      <h3>${metric.label} per day</h3>
      <p class="ins-sub">${chartable.length > 1 ? "Select a card above to change the metric. " : ""}${metric.additive ? "" : `Daily ${metric.label.toLowerCase()} does not add up to the range total.`}</p>
      ${insightsChart(report, metric.key)}
    </section>` : ""}`;
}

function syncLine(status: InsightStatus | null, extra: Html | string = ""): Html {
  const last = status?.lastSuccessfulSyncAt ? html`Last sync: ${localTime(new Date(status.lastSuccessfulSyncAt))}` : t("insights.sync.never");
  return html`<div class="ins-meta" id="insights-sync"><span><span class="ins-live${status?.displayStatus === "connected" ? " ins-live-ok" : ""}" aria-hidden="true"></span>${last}</span><span>${t("insights.sync.provisional")}</span>${extra}</div>`;
}

const pollBlock = (channelId: string, since: string, n: number) =>
  html`<span class="ins-poll" hx-get="${PATH}/status?channel=${channelId}&since=${encodeURIComponent(since)}&n=${n}" hx-trigger="load delay:5s" hx-target="#insights-sync" hx-swap="outerHTML">${t("insights.refresh.queued")}</span>`;

/** Brand, channel and range each submit their own GET form, so changing one keeps the rest of the URL state. */
function filters(channels: InsightChannelOption[], q: InsightsQuery, brands: Array<{ key: string; name: string }>, selectedId: string | null): Html {
  const form = (cls: string, keep: Html[], control: Html, trigger = "") =>
    html`<form class="${cls}" method="get" action="${PATH}" ${hxNav} ${trigger ? html`hx-trigger="${trigger}"` : ""}>${keep}${control}</form>`;
  const current = { ...q, channel: selectedId ?? "" };
  const brand = brands.length > 1 ? form("ins-field", hidden(current, ["brand", "channel"]), html`<label><span class="sr-only">Brand</span>
    <select class="input" name="brand" aria-label="Brand"><option value="">All brands</option>${brands.map((b) => html`<option value="${b.key}" ${q.brand === b.key ? "selected" : ""}>${b.name}</option>`)}</select>
    </label><noscript><button type="submit" class="btn btn-secondary">Show</button></noscript>`, "change, submit") : "";
  const channel = form("ins-field ins-channel", hidden(current, ["channel"]), html`<label><span class="sr-only">Channel</span>
    <select class="input" name="channel" aria-label="Channel">${selectedId ? "" : html`<option value="" selected disabled>Choose a channel</option>`}
      ${channels.map((c) => html`<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${c.label}</option>`)}</select>
    </label><noscript><button type="submit" class="btn btn-secondary">Show</button></noscript>`, "change, submit");
  const range = html`<div class="ins-seg" role="group" aria-label="Range">${INSIGHT_RANGES.map((r) => form("", hidden(current, ["range"]),
    html`<button type="submit" name="range" value="${String(r)}" aria-pressed="${q.range === r ? "true" : "false"}">${r} days</button>`))}</div>`;
  return html`<div class="ins-filters">${brand}${channel}${range}</div>`;
}

function notice(code: string): Html | string {
  const n = NOTICES[code];
  return n ? html`<div class="notice notice-${n.tone}" role="status">${n.text}</div>` : "";
}

/** The swappable page body (#insights-root). */
function insightsRoot(data: Awaited<ReturnType<typeof loadInsightsPage>>, brands: Array<{ key: string; name: string }>, noticeCode: string): Html {
  const { channels, selected, report } = data;
  const channel = selected ? channels.find((c) => c.id === selected.channelId) : undefined;
  // Every form below carries the channel actually shown, also when the URL relied on the default.
  const q = channel ? { ...data.query, channel: channel.id } : data.query;
  const status = report?.status ?? null;
  const canRefresh = !!status && status.collectionMode === "on" && status.displayStatus !== "additional_access_required" && status.reason !== "channel_paused";
  const head = html`<div class="ins-head"><div><h1>${t("insights.title")}</h1><p class="section-intro">${t("insights.intro")}</p></div>
    ${canRefresh ? html`<form method="post" action="${PATH}/refresh" hx-post="${PATH}/refresh" hx-target="#insights-sync" hx-swap="outerHTML">
      <input type="hidden" name="channel" value="${selected!.channelId}" />${hidden(q, ["channel", "metric"])}
      <button type="submit" class="btn btn-secondary">Refresh data</button></form>` : ""}</div>`;
  let body: Html;
  if (!channels.length && !q.brand) {
    body = stateCard("info", t("insights.noChannels.title"), t("insights.noChannels.body", { platforms: insightPlatforms().join(", ") }), html`<a class="btn btn-secondary" href="/channels">Go to Channels</a>`);
  } else if (!channel || !report || !status) {
    body = html`${filters(channels, q, brands, null)}${stateCard("info", t("insights.missing.title"), t("insights.missing.body"))}`;
  } else {
    const access = accessState(status, report, channel, q);
    const showData = !access || (status.collectionMode === "off" && report.series.length > 0) || status.displayStatus === "additional_access_required" && report.series.length > 0;
    body = html`${filters(channels, q, brands, channel.id)}${syncLine(status)}${access ?? ""}${access && !showData ? "" : html`${freshnessBanners(status)}${dataView(report, q)}`}`;
  }
  return html`<div class="page ins-page" id="insights-root">${head}${notice(noticeCode)}${body}</div>`;
}

function locked(upgradeUrl: string): Html {
  return html`<div class="page ins-page" id="insights-root">
    <h1>${t("insights.title")} <span class="badge">PRO</span></h1>
    <div class="card ins-lock"><p>${t("insights.locked")}</p>
      <a class="btn btn-primary" href="${upgradeUrl}" target="_blank" rel="noopener">Upgrade to PRO</a>
      <a class="btn" href="/overview">Back to overview</a></div>
  </div>`;
}

async function renderRoot(workspaceId: string, params: URLSearchParams): Promise<Html> {
  const [data, brands] = await Promise.all([loadInsightsPage(workspaceId, params), listBrands(workspaceId)]);
  return insightsRoot(data, brands, (params.get("notice") ?? "").slice(0, 32));
}

const isChannelId = (id: string) => id !== "" && id !== "invalid";
const fragmentRequest = (c: Context) => c.req.header("HX-Request") === "true" && c.req.header("HX-History-Restore-Request") !== "true";

/** Delegate to the shared REST handler; a refusal thrown by the boundary becomes its JSON response. */
/** The page's CSP only lets a form submission end on this origin, so a redirect to the platform dialog is a
 *  separate navigation: a short page that forwards there (and links there without scripting). */
function platformDialogPage(redirect: Response): Response {
  const to = redirect.headers.get("location") ?? "";
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  const cookie = redirect.headers.get("set-cookie");
  if (cookie) headers.set("set-cookie", cookie);
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Continue to the login dialog</title></head><body><p><a href="${to}">Continue to the login dialog</a></p></body></html>`;
  return new Response(String(page), { status: 200, headers });
}

async function delegate(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ApiError) return apiErrorResponse(e);
    throw e;
  }
}

function apiRequest(c: Context, method: string, body?: unknown): Request {
  const headers = new Headers();
  const cookie = c.req.header("cookie");
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(c.req.url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function formValues(c: Context): Promise<URLSearchParams> {
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (typeof v === "string") out.set(k, v);
  return out;
}

const backHref = (q: InsightsQuery, notice?: string) => {
  const href = insightsHref(q);
  return notice ? `${href}${href.includes("?") ? "&" : "?"}notice=${notice}` : href;
};
const toParams = (q: InsightsQuery) => new URLSearchParams(insightsHref(q).split("?")[1] ?? "");

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export function registerInsights(app: Hono, requireAuth: MiddlewareHandler): void {
  app.get(PATH, requireAuth, async (c) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    const params = new URL(c.req.url).searchParams;
    const root = features.has("insights") ? await renderRoot(a.workspaceId, params) : locked(upgradeUrl);
    if (fragmentRequest(c)) return c.html(root);
    return c.html(dashboardDoc(t("title.suffix", { section: t("insights.title") }), PATH, root, features, products));
  });

  // Turn collection on/off through the same handler as PATCH /api/v1/channels/:id/insights.
  app.post(`${PATH}/collection`, requireAuth, async (c) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return c.redirect("/login");
    const form = await formValues(c);
    const q = readInsightsQuery(form);
    if (!isChannelId(q.channel)) return c.text("not found", 404);
    const mode = form.get("mode") === "off" ? "off" : "on";
    const res = await delegate(() => insightsApi.PATCH(apiRequest(c, "PATCH", { collectionMode: mode }), { params: Promise.resolve({ channelId: q.channel }) }));
    if (!fragmentRequest(c)) return c.redirect(backHref(q, res.ok ? undefined : "consent_failed"), 303);
    if (!res.ok) return c.html(html`<div class="notice notice-err" role="alert">${await errorMessage(res, "Could not change Insights collection.")}</div>`, 422);
    return c.html(await renderRoot(a.workspaceId, toParams(q)));
  });

  // Queue a refresh through the same handler as POST /api/v1/channels/:id/insights/refresh.
  app.post(`${PATH}/refresh`, requireAuth, async (c) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return c.redirect("/login");
    const q = readInsightsQuery(await formValues(c));
    if (!isChannelId(q.channel)) return c.text("not found", 404);
    const ref: ChannelRef = { workspaceId: a.workspaceId, channelId: q.channel };
    const res = await delegate(() => refreshApi.POST(apiRequest(c, "POST"), { params: Promise.resolve({ channelId: q.channel }) }));
    if (!fragmentRequest(c)) return c.redirect(backHref(q, res.status === 202 ? "refresh_queued" : "refresh_later"), 303);
    if (res.status === 202) {
      const status = await getInsightStatus(ref);
      return c.html(syncLine(status, pollBlock(q.channel, status.lastSuccessfulSyncAt ?? "", 1)));
    }
    if (res.status === 429) {
      const body = (await res.json()) as { error?: { details?: { next_retry_at?: string } } };
      const nextAt = body.error?.details?.next_retry_at;
      const status = await getInsightStatus(ref);
      const [before, after] = t("insights.refresh.later", { at: "\u0000" }).split("\u0000");
      return c.html(syncLine(status, nextAt ? html`<span class="ins-poll">${before}${localTime(new Date(nextAt))}${after}</span>` : ""));
    }
    return c.html(html`<div class="notice notice-err" role="alert" id="insights-sync">${await errorMessage(res, "Refresh is not available for this channel.")}</div>`);
  });

  // Bounded polling of the locally stored status after a refresh: every 5 s, at most 12 times.
  app.get(`${PATH}/status`, requireAuth, async (c) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return c.redirect("/login");
    const params = new URL(c.req.url).searchParams;
    const q = readInsightsQuery(params);
    if (!isChannelId(q.channel)) return c.text("not found", 404);
    const n = Math.max(1, Math.min(POLL_LIMIT, Number.parseInt(params.get("n") ?? "1", 10) || 1));
    const since = (params.get("since") ?? "").slice(0, 40);
    const status = await delegate(async () => { await insightsApi.authorizeInsights(apiRequest(c, "GET"), { params: Promise.resolve({ channelId: q.channel }) }, "stats:read"); return new Response(null, { status: 204 }); });
    if (status.status !== 204) return c.html(html`<div class="ins-meta" id="insights-sync">${await errorMessage(status, "Status is not available.")}</div>`);
    const current = await getInsightStatus({ workspaceId: a.workspaceId, channelId: q.channel });
    if (current.lastSuccessfulSyncAt && current.lastSuccessfulSyncAt !== since) {
      return c.html(syncLine(current, html`<span class="ins-poll">${t("insights.refresh.done")} <a href="${insightsHref({ channel: q.channel })}">Show new data</a></span>`));
    }
    if (n >= POLL_LIMIT) return c.html(syncLine(current, html`<span class="ins-poll">${t("insights.refresh.waiting")}</span>`));
    return c.html(syncLine(current, pollBlock(q.channel, since, n + 1)));
  });

  // Start the platform consent for this channel (the transport is chosen from its stored credentials).
  app.post(`${PATH}/consent`, requireAuth, async (c) => {
    const session = await authenticateSession(c.req.raw).catch(() => null);
    if (!session) return c.redirect("/login");
    const q = readInsightsQuery(await formValues(c));
    if (!isChannelId(q.channel)) return c.text("not found", 404);
    const res = await delegate(() => beginInsightConsent({ workspaceId: session.workspaceId, channelId: q.channel }, session));
    if (res.status === 302) return platformDialogPage(res);
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code ?? "";
    return c.redirect(backHref({ ...q, metric: "" }, code in NOTICES ? code : "consent_failed"), 303);
  });
}

const DISPLAY_LABEL: Record<InsightStatus["displayStatus"], string> = {
  off: "Off", checking: "Checking access", additional_access_required: "Additional access required", connected: "Connected",
};

/** Insights status on the channel detail page; empty for platforms without the capability. */
export async function channelInsightsPanel(workspaceId: string, channel: { id: string; platform: string }, licensed: boolean): Promise<Html | string> {
  const platform = platformEnum.enumValues.find((p): p is Platform => p === channel.platform);
  if (!platform || !getInsightsConnector(platform)) return "";
  if (!licensed) return html`<section class="panel ins-channel-panel"><div class="panel-head"><h3>Insights</h3></div><div class="set-body"><p class="set-lead" style="margin:0">Account Insights are a PRO feature.</p></div></section>`;
  const status = await getInsightStatus({ workspaceId, channelId: channel.id });
  const tone = status.displayStatus === "connected" ? "ok" : status.displayStatus === "additional_access_required" ? "warn" : "neutral";
  const cta = status.displayStatus === "additional_access_required" && status.state !== "unsupported" ? consentForm(channel.id, status.state === "needs_reauth" ? "Sign in again" : "Grant Insights access") : "";
  return html`<section class="panel ins-channel-panel">
    <div class="panel-head"><h3>Insights</h3><a class="panel-more" href="/insights?channel=${channel.id}">Open Insights →</a></div>
    <div class="set-body">
      <p class="set-lead" style="margin:0 0 8px"><span class="badge tone-${tone}">${DISPLAY_LABEL[status.displayStatus]}</span>
        ${status.lastSuccessfulSyncAt ? html` Last sync: ${localTime(new Date(status.lastSuccessfulSyncAt))}` : ""}</p>
      ${status.displayStatus === "additional_access_required" ? html`<p class="small" style="margin:0 0 8px">${t("insights.permission.declined")}</p>` : ""}
      ${cta}
    </div>
  </section>`;
}
