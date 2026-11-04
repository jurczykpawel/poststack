import { html, raw } from "hono/html";
import { isUuid } from "@/lib/api/identifiers";
import { redactSecrets } from "@/lib/redact";
import { btn } from "../components/button";
import { dataList, listHref, readListState, type DataListProps, type ListColumn, type ListState } from "../components/data-list";
import { fmtCount, fmtDate, localTime, relTime } from "../components/format";
import { icon } from "../components/icons";
import { platformGlyph } from "../components/platform";
import { postPreview } from "../components/post-preview";
import { deliveryPostCard } from "@/lib/posts/preview";
import { rescheduleForm } from "../components/reschedule";
import { statusBadge } from "../components/status";
import { urlLink } from "../components/url";
import {
  QUEUE_SECTIONS, channelOptions, getQueueItem, isQueueSection, linkedPostText, queueCounts, scheduledDays, sectionPage, sectionRows,
  type QueueFilters, type QueueRow, type QueueSection,
} from "./queue-data";

type Html = ReturnType<typeof html>;
type PanelSection = Exclude<QueueSection, "attention">;

const PATH = "/queue";
const ATTEMPT_BUDGET = 5;
const PAGE_SIZE = 50;
const SHOW_STEP = 20;
const MAX_SHOWN = 200;
const MAX_DAYS = 14;
const FIRST_ROWS: Record<PanelSection, number> = { scheduled: 12, published: 6, canceled: 6 };
const SECTION_LABEL: Record<QueueSection, string> = { scheduled: "Scheduled", published: "Published", canceled: "Canceled", attention: "Needs attention" };
const SECTION_HINT: Record<PanelSection, string> = { scheduled: "soonest first", published: "newest first", canceled: "newest first" };
const SECTION_TONE: Record<PanelSection, string> = { scheduled: "info", published: "ok", canceled: "neutral" };
const showKey = (s: PanelSection) => `show_${s}`;

const clock = (at: Date, tz: string) => at.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
const localDay = (at: Date, tz: string) => at.toLocaleDateString("en-CA", { timeZone: tz });
const shortDate = (at: Date, tz: string) => at.toLocaleDateString("en-GB", { timeZone: tz, day: "numeric", month: "short" });

function dayName(day: string, tz: string): { long: string; short: string } {
  const noon = new Date(`${day}T12:00:00Z`);
  const today = localDay(new Date(), tz);
  const tomorrow = localDay(new Date(Date.now() + 86_400_000), tz);
  if (day === today) return { long: "Today", short: "Today" };
  if (day === tomorrow) return { long: "Tomorrow", short: "Tmrw" };
  const weekday = noon.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  const date = noon.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  return { long: `${weekday}, ${date}`, short: `${weekday} ${noon.getUTCDate()}` };
}

// Every action sits inside the list's htmx scope; only the address must stay where it is.
const STAY = raw('hx-push-url="false"');

function actionForm(id: string, verb: string, label: string, opts: { confirm?: string; className: string }): Html {
  const act = `/queue/${id}/${verb}`;
  return html`<form class="q-form" method="post" action="${act}" hx-post="${act}" ${STAY} hx-disabled-elt="find button"${opts.confirm ? html` hx-confirm="${opts.confirm}" data-confirm-label="${label}"` : ""}><button class="${opts.className}" type="submit">${label}</button></form>`;
}

const PUBLISH_CONFIRM = "Publish this post now?";
const RETRY_CONFIRM = "Retry publishing this post now?";
const CANCEL_CONFIRM = "Cancel this post? It will not be published.";
const isPending = (status: string) => status === "scheduled" || status === "held";

/** One visible action and a menu; everything else lives in the post's panel. */
function rowActions(r: QueueRow, st: ListState): Html | string {
  const open = listHref(PATH, st, { open: r.id });
  if (r.status === "failed" || r.status === "unknown") {
    const retry = r.status === "failed" ? actionForm(r.id, "retry", "Retry", { confirm: RETRY_CONFIRM, className: "btn btn-secondary btn-sm" }) : "";
    return html`<span class="q-act">${retry}${actionForm(r.id, "cancel", "Cancel post", { confirm: CANCEL_CONFIRM, className: "btn btn-ghost btn-sm" })}</span>`;
  }
  if (!isPending(r.status)) return "";
  const review = r.tiktokConfirmation === "required";
  return html`<span class="q-act">
    ${review
      ? html`<span class="q-pn"><a class="btn btn-secondary btn-sm" href="/queue/${r.id}/confirm" hx-boost="false">Review TikTok settings</a></span>`
      : html`<span class="q-pn">${actionForm(r.id, "publish-now", "Publish now", { confirm: PUBLISH_CONFIRM, className: "btn btn-ghost btn-sm" })}</span>`}
    <details class="q-menu" x-data @click.outside="$el.open = false" @keydown.escape="$el.open = false">
      <summary class="btn-ic" aria-label="More actions" title="More actions">${icon("dots", "ico", 16)}</summary>
      <div class="q-menu-pop">
        ${review ? "" : html`<a href="${open}">Edit text</a><a href="${open}">Reschedule</a>`}
        ${actionForm(r.id, "cancel", "Cancel post", { confirm: CANCEL_CONFIRM, className: "q-danger" })}
      </div>
    </details>
  </span>`;
}

const channelCell = (r: QueueRow) => html`<span class="q-chan" title="${r.channelName}">${platformGlyph(r.platform, 14, r.metadata)}<span>${r.channelName}</span></span>`;
const textOf = (r: QueueRow) => r.text ?? html`<span class="muted">No text · ${r.format}</span>`;

function sectionRow(r: QueueRow, section: PanelSection, st: ListState, tz: string): Html {
  const stamp = section === "scheduled" ? clock(r.scheduledAt, tz) : relTime(r.scheduledAt);
  const opened = st.open === r.id;
  return html`<li class="q-row" id="post-row-${r.id}" data-row="${r.id}"${opened ? raw(' aria-current="true"') : raw("")}>
    <span class="q-t" data-local-title="${r.scheduledAt.toISOString()}" title="${fmtDate(r.scheduledAt)}">${stamp}</span>
    ${channelCell(r)}
    <a class="q-text dl-rowlink" href="${listHref(PATH, st, { open: r.id })}">${textOf(r)}</a>
    <span class="q-fmt">${r.format}</span>
    <span class="q-meta">${r.channelName} · ${stamp}</span>
    <span class="q-end">${r.status === "scheduled" || r.status === "sent" || r.status === "canceled" ? "" : statusBadge(r.status)}${rowActions(r, st)}</span>
  </li>`;
}

function rowsWithDays(rows: QueueRow[], st: ListState, tz: string): Html[] {
  let last = "";
  return rows.flatMap((r) => {
    const day = localDay(r.scheduledAt, tz);
    const head = day === last ? [] : [html`<li class="q-day">${dayName(day, tz).long}</li>`];
    last = day;
    return [...head, sectionRow(r, "scheduled", st, tz)];
  });
}

function moreBar(section: PanelSection, st: ListState, shown: number, total: number): Html | string {
  if (shown >= total) return "";
  const next = Math.min(shown + SHOW_STEP, MAX_SHOWN);
  const grown: ListState = { ...st, keep: { ...st.keep, [showKey(section)]: String(next) } };
  return html`<div class="q-more">
    ${next > shown ? html`<a class="btn btn-secondary btn-sm" href="${listHref(PATH, grown, {})}">Show ${Math.min(next, total) - shown} more</a>` : ""}
    <span class="muted">${fmtCount(shown)} of ${fmtCount(total)}</span>
    <a class="btn btn-ghost btn-sm q-full" href="${listHref(PATH, st, { filter: { status: section, day: "" } })}">Open full list</a>
  </div>`;
}

const sumOf = (counts: Map<string, number>, s: QueueSection) => QUEUE_SECTIONS[s].reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);

function sectionBlock(p: { section: PanelSection; total: number; open: boolean; top?: Html | string; body: Html | Html[]; more: Html | string; empty: string }): Html {
  return html`<details class="q-sec" data-section="${p.section}"${p.open ? raw(" open") : raw("")}>
    <summary>${icon("chevron", "ico q-chev", 14)}<h2>${SECTION_LABEL[p.section]}</h2><span class="badge tone-${SECTION_TONE[p.section]}">${fmtCount(p.total)}</span><span class="muted q-hint">${SECTION_HINT[p.section]}</span></summary>
    ${p.top ?? ""}
    ${p.total ? html`<ul class="q-rows">${p.body}</ul>${p.more}` : html`<p class="muted q-none">${p.empty}</p>`}
  </details>`;
}

function attentionBand(counts: Map<string, number>, st: ListState): Html | string {
  const n = sumOf(counts, "attention");
  if (!n) return "";
  const breakdown = QUEUE_SECTIONS.attention.flatMap((s) => (counts.get(s) ? [`${fmtCount(counts.get(s)!)} ${s}`] : [])).join(" · ");
  return html`<div class="q-band" role="status">${icon("alert", "ico", 16)}
    <span><b>${fmtCount(n)} ${n === 1 ? "post needs" : "posts need"} your attention</b> <span class="q-band-sub">${breakdown}</span></span>
    <a class="btn btn-secondary btn-sm" href="${listHref(PATH, st, { filter: { status: "attention", day: "" } })}">Review</a>
  </div>`;
}

function shownOf(url: URL, section: PanelSection): number {
  const raw = Number(url.searchParams.get(showKey(section)));
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_SHOWN) : FIRST_ROWS[section];
}

function validDay(day: string | undefined): day is string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().startsWith(day);
}

async function panel(workspaceId: string, st: ListState): Promise<{ detail?: DataListProps<QueueRow>["detail"]; status?: string }> {
  if (!isUuid(st.open)) return {};
  const item = await getQueueItem(workspaceId, st.open);
  if (!item) return {};
  const { post, channel, channelName } = item;
  const payload = post.payload as { caption?: string; title?: string; media?: unknown[] } | null;
  const [linked, card] = await Promise.all([linkedPostText(workspaceId, post.id), post.status === "sent" ? deliveryPostCard(workspaceId, post.id) : undefined]);
  const review = post.tiktok_confirmation === "required";
  const editable = isPending(post.status) && !review;
  const act = `/queue/${post.id}`;
  const text = linked ? linked.description ?? "" : payload?.caption ?? "";
  const shown = redactSecrets(JSON.stringify(post.payload, null, 2));
  return {
    status: post.status,
    detail: {
      title: html`<span class="q-chan">${platformGlyph(channel.platform, 15, channel.metadata)}<span>${channelName}</span></span>`,
      body: html`<p class="q-panel-status">${statusBadge(post.status)} <span class="q-fmt">${post.format}</span></p>
        ${post.last_error ? html`<p class="dl-problem q-panel-error">${post.last_error}</p>` : ""}
        ${editable
          ? html`<form class="q-edit" method="post" action="${act}/text" hx-post="${act}/text" ${STAY} hx-disabled-elt="find button">
              <label class="dl-label" for="q-text">Text</label>
              <textarea class="textarea" id="q-text" name="text" rows="6">${text}</textarea>
              ${linked?.hashtags ? html`<p class="muted q-hint-line">Published with: ${linked.hashtags}</p>` : ""}
              <button class="btn btn-primary btn-sm" type="submit">Save text</button>
            </form>`
          : card ? postPreview(card) : html`<p class="dl-label">Text</p><p class="q-panel-text">${payload?.caption || payload?.title || "—"}</p>`}
        <dl class="dl-facts">
          <dt>${post.status === "sent" ? "Published" : post.status === "canceled" ? "Was due" : "When"}</dt><dd>${localTime(post.scheduled_at)}</dd>
          <dt>Attempts</dt><dd>${post.attempts}/${ATTEMPT_BUDGET}</dd>
          ${post.provider_handle ? html`<dt>On platform</dt><dd>${urlLink(post.provider_handle)}</dd>` : ""}
        </dl>
        ${editable ? rescheduleForm(`${act}/reschedule`, "#data-list") : ""}
        <div class="q-panel-acts">
          ${review ? html`<a class="btn btn-primary btn-sm" href="${act}/confirm">Review TikTok settings</a>` : ""}
          ${editable ? actionForm(post.id, "publish-now", "Publish now", { confirm: PUBLISH_CONFIRM, className: "btn btn-secondary btn-sm" }) : ""}
          ${post.status === "failed" ? actionForm(post.id, "retry", "Retry", { confirm: RETRY_CONFIRM, className: "btn btn-primary btn-sm" }) : ""}
          ${isPending(post.status) || post.status === "failed" || post.status === "unknown" ? actionForm(post.id, "cancel", "Cancel post", { confirm: CANCEL_CONFIRM, className: "btn btn-danger btn-sm" }) : ""}
        </div>
        <details class="q-tech"><summary class="muted">Technical details</summary><pre class="dl-json">${shown}</pre><a class="btn btn-ghost btn-sm" href="${act}">Full post page</a></details>`,
    },
  };
}

function shared(st: ListState, channels: { id: string; label: string }[], formats: string[]) {
  return {
    path: PATH,
    noun: "posts",
    state: st,
    searchPlaceholder: "Search post text or channel…",
    selects: [
      { key: "channel", label: "Channel", options: channels.map((ch) => ({ value: ch.id, label: ch.label })) },
      { key: "format", label: "Format", options: formats.map((f) => ({ value: f, label: f })) },
    ],
    rowId: (r: QueueRow) => r.id,
    emptyTitle: "Nothing here yet",
    emptyBody: "Posts appear here as you schedule and publish them.",
  };
}

function fullListColumns(section: QueueSection, st: ListState, tz: string): ListColumn<QueueRow>[] {
  const when: ListColumn<QueueRow> = { label: "When", width: "13%", cell: (r) => html`<span class="dl-when" data-local-title="${r.scheduledAt.toISOString()}" title="${fmtDate(r.scheduledAt)}">${section === "scheduled" ? `${shortDate(r.scheduledAt, tz)}, ${clock(r.scheduledAt, tz)}` : relTime(r.scheduledAt)}</span>` };
  const channel: ListColumn<QueueRow> = { label: "Channel", width: "18%", cell: channelCell };
  const text: ListColumn<QueueRow> = { label: "Post", width: "33%", main: true, cell: textOf };
  const acts: ListColumn<QueueRow> = { label: "", width: section === "attention" ? "13%" : "17%", cell: (r) => rowActions(r, st) };
  const status: ListColumn<QueueRow> = { label: "Status", width: "11%", cell: (r) => statusBadge(r.status) };
  const middle: ListColumn<QueueRow> = section === "attention"
    ? { label: "Problem", width: "22%", cell: (r) => r.lastError ?? "—" }
    : { label: "Format", width: "8%", cell: (r) => r.format };
  return [when, channel, text, middle, status, acts];
}

function sub(r: QueueRow, section: QueueSection, tz: string): string {
  const at = section === "scheduled" ? `${shortDate(r.scheduledAt, tz)}, ${clock(r.scheduledAt, tz)}` : relTime(r.scheduledAt);
  return section === "attention" && r.lastError ? `${r.channelName} · ${r.lastError}` : `${r.channelName} · ${at}`;
}

function blankSlate(): Html {
  return html`<div class="empty">
    <span class="empty-ic">${icon("queue", "ico", 20)}</span>
    <p class="empty-title">Nothing queued yet</p>
    <p class="empty-body">Scheduled and published posts land here. Publish or schedule content from the composer.</p>
    ${btn({ label: "Open composer", href: "/compose", variant: "secondary", size: "sm", icon: "compose" })}
  </div>`;
}

/** The whole list for one address. Pages and actions both render through here, so filters survive an action. */
export async function renderQueue(workspaceId: string, href: string, tz: string): Promise<Html> {
  const url = new URL(href);
  const st = readListState(href, ["status", "channel", "format", "day"]);
  if (!isUuid(st.filters.channel)) delete st.filters.channel;
  if (!isQueueSection(st.filters.status)) delete st.filters.status;
  if (!validDay(st.filters.day) || st.filters.status) delete st.filters.day;
  const section = st.filters.status as QueueSection | undefined;

  const filters: QueueFilters = { workspaceId, q: st.q, channelId: st.filters.channel, format: st.filters.format };
  const [{ byStatus: counts, formats }, channels, opened] = await Promise.all([queueCounts(filters), channelOptions(workspaceId), panel(workspaceId, st)]);
  const base = shared(st, channels, formats);

  if (section) {
    const page = await sectionPage(filters, section, PAGE_SIZE, st.after, st.before);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return dataList<QueueRow>({
      ...base,
      chips: { key: "status", label: "Section", all: total, options: (Object.keys(QUEUE_SECTIONS) as QueueSection[]).map((s) => ({ value: s, label: SECTION_LABEL[s], count: sumOf(counts, s) })) },
      columns: fullListColumns(section, st, tz),
      rows: page.rows,
      sub: (r) => sub(r, section, tz),
      page,
      pagerLabels: section === "scheduled" ? { prev: "Earlier", next: "Later" } : undefined,
      detail: opened.detail,
    });
  }

  const anyFilter = !!st.q || !!st.filters.channel || !!st.filters.format;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total && !anyFilter) return html`<div id="data-list">${blankSlate()}</div>`;

  st.keep = Object.fromEntries((Object.keys(FIRST_ROWS) as PanelSection[]).flatMap((s) => (url.searchParams.has(showKey(s)) ? [[showKey(s), String(shownOf(url, s))]] : [])));
  const day = st.filters.day;
  const [days, scheduled, published, canceled] = await Promise.all([
    scheduledDays(filters, tz, MAX_DAYS),
    sectionRows(filters, "scheduled", shownOf(url, "scheduled"), day ? { day, tz } : undefined),
    sectionRows(filters, "published", shownOf(url, "published")),
    sectionRows(filters, "canceled", shownOf(url, "canceled")),
  ]);
  const scheduledTotal = sumOf(counts, "scheduled");
  const dayTotal = day ? days.find((d) => d.day === day)?.n ?? scheduled.length : scheduledTotal;

  const dayChip = (value: string, label: string, n: number) =>
    html`<a class="q-daychip" href="${listHref(PATH, st, { filter: { day: value } })}"${(st.filters.day ?? "") === value ? raw(' aria-current="true"') : raw("")}>${label}<b>${fmtCount(n)}</b></a>`;
  const dayBar = scheduledTotal
    ? html`<nav class="q-days" aria-label="Jump to day">${dayChip("", "All", scheduledTotal)}${days.map((d) => dayChip(d.day, dayName(d.day, tz).short, d.n))}</nav>`
    : "";

  const plain = (rows: QueueRow[], s: PanelSection) => rows.map((r) => sectionRow(r, s, st, tz));
  const body = html`<div class="q-sections">
    ${sectionBlock({ section: "scheduled", total: scheduledTotal, open: true, top: dayBar, body: rowsWithDays(scheduled, st, tz), more: moreBar("scheduled", st, scheduled.length, dayTotal), empty: "Nothing scheduled." })}
    ${sectionBlock({ section: "published", total: sumOf(counts, "published"), open: true, body: plain(published, "published"), more: moreBar("published", st, published.length, sumOf(counts, "published")), empty: "Nothing published yet." })}
    ${sectionBlock({ section: "canceled", total: sumOf(counts, "canceled"), open: url.searchParams.has(showKey("canceled")) || opened.status === "canceled", body: plain(canceled, "canceled"), more: moreBar("canceled", st, canceled.length, sumOf(counts, "canceled")), empty: "Nothing canceled." })}
  </div>`;

  return dataList<QueueRow>({ ...base, lead: attentionBand(counts, st), columns: [], rows: [], body, detail: opened.detail });
}

/** Where a list action should re-render from: the viewer's address, never another origin's. */
export function currentListUrl(requestUrl: string, header: string | undefined): string {
  const fallback = new URL(PATH, requestUrl);
  try {
    const current = new URL(header ?? "", fallback);
    return `${fallback.origin}${PATH}${current.search}`;
  } catch {
    return fallback.toString();
  }
}
