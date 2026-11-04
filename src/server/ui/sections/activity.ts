import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { authenticate } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { t } from "@/lib/i18n";
import { isHtmx } from "../components/toast";
import { dashboardDoc } from "../layout";
import { renderEvents } from "./events";
import { renderWebhooksLog } from "./webhooks-log";
import { renderSentLog } from "./sent-log";
import { aiLogLocked, renderAiLog } from "./ai-generation-logs";

/**
 * Activity (UXFLOW1 stage 3): one address, `/activity?source=events|webhooks|ai`, three logs on the shared list.
 * The old addresses (`/events`, `/webhooks/:id`) redirect here and keep their query.
 */

const PATH = "/activity";
const SOURCES = [
  { key: "events", label: "Events" },
  { key: "webhooks", label: "Webhooks" },
  { key: "ai", label: "AI log" },
  { key: "sent", label: "Sent replies" },
] as const;
type SourceKey = (typeof SOURCES)[number]["key"];

/** 302 to Activity on `source`, carrying over the old address's own params (filters, page, open row). */
export function activityRedirect(c: Context, source: SourceKey, extra: Record<string, string> = {}) {
  const to = new URLSearchParams({ source });
  new URL(c.req.url).searchParams.forEach((v, k) => { if (k !== "source") to.set(k, v); });
  for (const [k, v] of Object.entries(extra)) to.set(k, v);
  return c.redirect(`${PATH}?${to}`);
}

export function registerActivity(r: Hono, guard: MiddlewareHandler): void {
  r.get("/events", guard, (c) => activityRedirect(c, "events"));

  r.get(PATH, guard, async (c: Context) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return isHtmx(c) ? c.body(null, 401, { "HX-Redirect": "/login" }) : c.redirect("/login");
    const { features, products, upgradeUrl } = await getInstanceLicense();
    const asked = new URL(c.req.url).searchParams.get("source");
    const source = SOURCES.find((s) => s.key === asked)?.key ?? "events";
    // The lists read `source` as a fixed param, so a bare /activity must carry its default too.
    const u = new URL(c.req.url);
    u.searchParams.set("source", source);
    const url = u.toString();
    const list =
      source === "webhooks" ? await renderWebhooksLog(a.workspaceId, url, PATH)
      : source === "sent" ? await renderSentLog(a.workspaceId, url, PATH)
      : source === "ai" ? (features.has("ai_draft") || features.has("ai_rephrase") ? await renderAiLog(a.workspaceId, url, PATH) : aiLogLocked(upgradeUrl))
      : await renderEvents(a.workspaceId, url, PATH);
    return c.html(
      dashboardDoc(
        t("title.suffix", { section: "Activity" }),
        PATH,
        html`<div class="page">
          <h1>Activity</h1>
          <p class="muted">What happened in this workspace: events, what the platforms delivered to your webhook, and every AI generation.</p>
          <nav class="seg dl-sources" aria-label="Source">${SOURCES.map((s) =>
            html`<a class="seg-btn${s.key === source ? " on" : ""}" href="${PATH}?source=${s.key}"${s.key === source ? html` aria-current="page"` : ""}>${s.label}</a>`)}</nav>
          ${list}
        </div>`,
        features,
        products,
      ),
    );
  });
}
