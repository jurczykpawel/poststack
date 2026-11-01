import { html, raw } from "hono/html";
import { fmtCount } from "./format";
import { icon } from "./icons";

/**
 * DataList: the shared long list (filters, counter chips, cursor pages, details panel). The URL owns
 * all state, so links, Back and reload just work. To use it from a GET route:
 *   const state = readListState(c.req.url, ["severity", "area"]);
 *   const page = await listPage({ ... });           // @/lib/list-page, with countBy for the chips
 *   return c.html(dashboardDoc(title, path, dataList({ path, noun, state, columns, rows: page.rows, rowId, page, ... })));
 * The route returns its normal full page; htmx swaps only #data-list out of it. Links inside `detail.body`
 * leave the list as ordinary navigation.
 */

type Html = ReturnType<typeof html>;

export interface ListState {
  q: string;
  filters: Record<string, string>;
  after: string;
  before: string;
  open: string;
}

export interface ListColumn<R> {
  label: string;
  /** CSS width of the column, e.g. "36%". */
  width: string;
  cell: (row: R) => Html | string;
  /** The one column kept on a phone; it also carries the link that opens the row. */
  main?: boolean;
  /** Right-aligned tabular figures. */
  num?: boolean;
}

export interface ListOption {
  value: string;
  label: string;
}

export interface DataListProps<R> {
  path: string;
  /** Plural, lower case: "events". */
  noun: string;
  state: ListState;
  searchPlaceholder: string;
  /** Sits above the toolbar, inside the swapped list: a switch between views of the same data. */
  tabs?: Html;
  /** One filter shown as counter chips above the list. */
  chips?: { key: string; label: string; all: number; options: Array<ListOption & { count: number }> };
  selects?: Array<{ key: string; label: string; options: ListOption[] }>;
  columns: ListColumn<R>[];
  rows: R[];
  rowId: (row: R) => string;
  /** Second line under the main column on a phone, where the other columns are hidden. */
  sub?: (row: R) => Html | string;
  page: { start: number; end: number; total: number; older: string | null; newer: string | null };
  /** The row named by `state.open`, when it exists. */
  detail?: { title: Html | string; body: Html };
  /** Shown when the list is empty with no filters applied. */
  emptyTitle: string;
  emptyBody: string;
}

const MAX_SEARCH = 200;

export function readListState(url: string, filterKeys: string[]): ListState {
  const p = new URL(url).searchParams;
  return {
    q: (p.get("q") ?? "").trim().slice(0, MAX_SEARCH),
    filters: Object.fromEntries(filterKeys.flatMap((k) => (p.get(k) ? [[k, p.get(k)!]] : []))),
    after: p.get("after") ?? "",
    before: p.get("before") ?? "",
    open: p.get("open") ?? "",
  };
}

/**
 * The address of this list with one thing changed. A filter or search change restarts from the
 * first page; a page change closes details; opening or closing details keeps the page.
 */
export function listHref(
  path: string,
  st: ListState,
  change: { filter?: Record<string, string>; after?: string; before?: string; open?: string } = {},
): string {
  const moved = change.after !== undefined || change.before !== undefined;
  const params = new URLSearchParams();
  if (st.q) params.set("q", st.q);
  for (const [k, v] of Object.entries({ ...st.filters, ...change.filter })) if (v) params.set(k, v);
  if (!change.filter) {
    const after = moved ? change.after : st.after;
    const before = moved ? change.before : st.before;
    if (after) params.set("after", after);
    if (before) params.set("before", before);
    const open = moved ? "" : change.open ?? st.open;
    if (open) params.set("open", open);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function toolbar<R>(p: DataListProps<R>): Html {
  const { state: st, path } = p;
  const active = !!st.q || Object.values(st.filters).some(Boolean);
  const chipValue = p.chips ? st.filters[p.chips.key] : "";
  return html`<form class="filter-bar dl-tools" method="get" action="${path}" role="search">
    <label class="filter-search"><span class="sr-only">Search ${p.noun}</span>${icon("search", "ico", 14)}<input id="dl-search" type="search" name="q" value="${st.q}" placeholder="${p.searchPlaceholder}" autocomplete="off" /></label>
    ${p.selects?.map((s) => html`<select name="${s.key}" aria-label="${s.label}">
      <option value="">${s.label}: all</option>
      ${s.options.map((o) => html`<option value="${o.value}"${st.filters[s.key] === o.value ? raw(" selected") : raw("")}>${o.label}</option>`)}
    </select>`)}
    ${p.chips && chipValue ? html`<input type="hidden" name="${p.chips.key}" value="${chipValue}" />` : ""}
    <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
    ${active ? html`<a class="filter-clear" href="${path}">Clear</a>` : ""}
  </form>`;
}

function chipLinks<R>(p: DataListProps<R>): Html | string {
  const c = p.chips;
  if (!c) return "";
  const current = p.state.filters[c.key] ?? "";
  const chip = (value: string, label: string, count: number) =>
    html`<a class="dl-chip" href="${listHref(p.path, p.state, { filter: { [c.key]: value } })}"${current === value ? raw(' aria-current="true"') : raw("")}>${label} <b>${fmtCount(count)}</b></a>`;
  return html`<nav class="dl-chips" aria-label="${c.label}">${chip("", "All", c.all)}${c.options.map((o) => chip(o.value, o.label, o.count))}</nav>`;
}

function table<R>(p: DataListProps<R>): Html {
  const cellClass = (col: ListColumn<R>) => [col.main ? "dl-main" : "", col.num ? "dl-num" : ""].join(" ").trim();
  return html`<table class="dl-table" aria-label="${p.noun}">
    <colgroup>${p.columns.map((col) => html`<col style="width:${col.width}" />`)}</colgroup>
    <thead><tr>${p.columns.map((col) => html`<th scope="col" class="${cellClass(col)}">${col.label}</th>`)}</tr></thead>
    <tbody>${p.rows.map((row) => {
      const id = p.rowId(row);
      return html`<tr data-row="${id}"${p.state.open === id ? raw(' aria-current="true"') : raw("")}>${p.columns.map((col) => html`<td class="${cellClass(col)}">${col.main
        ? html`<a class="dl-rowlink" href="${listHref(p.path, p.state, { open: id })}">${col.cell(row)}</a>${p.sub ? html`<div class="dl-sub">${p.sub(row)}</div>` : ""}`
        : col.cell(row)}</td>`)}</tr>`;
    })}</tbody>
  </table>`;
}

function pager<R>(p: DataListProps<R>): Html {
  const { older, newer, start, end, total } = p.page;
  const toTop = raw('hx-swap="outerHTML show:#data-list:top"');
  const link = (label: string, rel: "prev" | "next", href: string | null) =>
    href
      ? html`<a class="btn btn-secondary btn-sm" rel="${rel}" href="${href}" ${toTop}>${label}</a>`
      : html`<span class="btn btn-secondary btn-sm" aria-disabled="true">${label}</span>`;
  return html`<div class="dl-pager">
    <span class="muted">${total ? `${fmtCount(start)}–${fmtCount(end)} of ${fmtCount(total)}` : `0 ${p.noun}`}</span>
    <span class="dl-pager-acts">
      ${link("Newer", "prev", newer ? listHref(p.path, p.state, { before: newer }) : null)}
      ${link("Older", "next", older ? listHref(p.path, p.state, { after: older }) : null)}
    </span>
  </div>`;
}

function emptyView<R>(p: DataListProps<R>): Html {
  const filtered = !!p.state.q || Object.values(p.state.filters).some(Boolean);
  return html`<div class="empty">
    <span class="empty-ic">${icon("search", "ico", 20)}</span>
    <p class="empty-title">${filtered ? `No ${p.noun} match these filters` : p.emptyTitle}</p>
    <p class="empty-body">${filtered ? "Try a wider filter or clear them all." : p.emptyBody}</p>
  </div>`;
}

function detailPanel<R>(p: DataListProps<R>): Html | string {
  if (!p.detail) return "";
  // Esc and the close button are one path; Back closes it too, because opening pushed an address.
  return html`<aside class="dl-detail" aria-label="Details" tabindex="-1" x-data x-init="$el.focus({ preventScroll: true })" @keydown.escape.window="$el.querySelector('.dl-close').click()">
    <div class="dl-detail-head">
      <h2>${p.detail.title}</h2>
      <a class="btn-ic dl-close" href="${listHref(p.path, p.state, { open: "" })}" data-row-return="${p.state.open}" aria-label="Close details" title="Close">${icon("close", "ico", 16)}</a>
    </div>
    <div hx-boost="false">${p.detail.body}</div>
  </aside>`;
}

export function dataList<R>(p: DataListProps<R>): Html {
  return html`<div id="data-list" class="dl" hx-history="false" hx-boost="true" hx-target="#data-list" hx-select="#data-list" hx-swap="outerHTML show:none" hx-push-url="true">
    ${p.tabs ?? ""}
    ${toolbar(p)}
    ${chipLinks(p)}
    <div class="dl-split${p.detail ? " has-detail" : ""}">
      <div class="dl-list">${p.rows.length ? table(p) : emptyView(p)}${pager(p)}</div>
      ${detailPanel(p)}
    </div>
  </div>`;
}
