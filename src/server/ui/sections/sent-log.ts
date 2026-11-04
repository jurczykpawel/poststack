import { html } from "hono/html";
import { and, eq, gte, lt, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, outboundDeliveries } from "@/db/schema";
import { listPage } from "@/lib/list-page";
import { deliveryLabel, startOfUtcDay } from "@/lib/stats/overview";
import { dataList, readListState, type ListColumn } from "../components/data-list";
import { fmtDate, localTime } from "../components/format";
import { PLATFORM_LABELS } from "../components/platform";
import { timeAgo } from "../components/time";

/** OVSENT1: what Overview's "Sent today (UTC)" / "Sent (all time)" count — outbound replies with status `sent`
 *  (the same table and day window as the cards). Identity-free like the Overview log: type, channel, time. */
type Row = { id: string; task_name: string; created_at: Date; platform: string | null; channel: string | null };

const COLUMNS: ListColumn<Row>[] = [
  { label: "Type", width: "30%", main: true, cell: (r) => deliveryLabel(r.task_name) },
  { label: "Channel", width: "40%", cell: (r) => r.channel ?? "—" },
  { label: "Platform", width: "15%", cell: (r) => (r.platform ? PLATFORM_LABELS[r.platform] ?? r.platform : "—") },
  { label: "Queued", width: "15%", cell: (r) => html`<span class="dl-when" title="${fmtDate(r.created_at)}">${timeAgo(r.created_at)}</span>` },
];

export async function renderSentLog(workspaceId: string, url: string, path: string) {
  const state = readListState(url, ["range"], ["source"]);
  const today = state.filters.range === "today";
  if (state.filters.range && !today) delete state.filters.range;
  const dayStart = startOfUtcDay(new Date());
  const sent = and(eq(outboundDeliveries.workspace_id, workspaceId), eq(outboundDeliveries.status, "sent"));
  const inToday = and(gte(outboundDeliveries.created_at, dayStart), lt(outboundDeliveries.created_at, new Date(dayStart.getTime() + 86_400_000)));
  const fetch = (q: { where: SQL | undefined; orderBy: SQL[]; limit: number }) =>
    db.select({ id: outboundDeliveries.id, task_name: outboundDeliveries.task_name, created_at: outboundDeliveries.created_at, platform: channels.platform, channel: channels.display_name })
      .from(outboundDeliveries).leftJoin(channels, eq(channels.id, outboundDeliveries.channel_id)).where(q.where).orderBy(...q.orderBy).limit(q.limit);
  const list = (where: SQL | undefined, limit: number, paging = false) => listPage<Row>({
    table: outboundDeliveries, where, time: outboundDeliveries.created_at, id: outboundDeliveries.id, limit,
    after: paging ? state.after : undefined, before: paging ? state.before : undefined, keyOf: (r) => ({ at: r.created_at, id: r.id }), fetch,
  });
  const [page, todayPage, allPage] = await Promise.all([list(and(sent, today ? inToday : undefined), 50, true), list(and(sent, inToday), 1), list(sent, 1)]);
  const opened = page.rows.find((r) => r.id === state.open);
  return dataList<Row>({
    path, noun: "sent replies", state, columns: COLUMNS, rows: page.rows, rowId: (r) => r.id, page,
    chips: { key: "range", label: "Range", all: allPage.total, options: [{ value: "today", label: "Today (UTC)", count: todayPage.total }] },
    sub: (r) => html`${r.channel ?? "—"} · ${timeAgo(r.created_at)}`,
    detail: opened ? { title: deliveryLabel(opened.task_name), body: html`<dl class="dl-facts"><dt>Channel</dt><dd>${opened.channel ?? "—"}</dd><dt>Queued</dt><dd>${localTime(opened.created_at)}</dd></dl>` } : undefined,
    emptyTitle: "Nothing sent yet", emptyBody: "Replies the rules, sequences and follow-gates have sent show up here.",
  });
}
