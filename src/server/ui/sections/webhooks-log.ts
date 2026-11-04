import { html } from "hono/html";
import { and, eq, inArray, or, sql, type AnyColumn } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, webhookEvents } from "@/db/schema";
import { containsPattern, countBy, listPage } from "@/lib/list-page";
import { isUuid } from "@/lib/api/identifiers";
import { redactSecrets } from "@/lib/redact";
import { dataList, readListState, type ListColumn } from "../components/data-list";
import { fmtDate, localTime } from "../components/format";
import { PLATFORM_LABELS } from "../components/platform";
import { timeAgo } from "../components/time";
import { WEBHOOK_STATUS_LEGEND, WEBHOOK_ENDPOINT_STATUSES, WEBHOOK_STATUS_TONE } from "./webhook-status";

/** The webhooks source of Activity: what the platforms delivered to this workspace's channels and how each was handled. */

const PAGE_SIZE = 50;

type HookRow = Pick<typeof webhookEvents.$inferSelect, "id" | "channel_id" | "platform" | "event_type" | "field" | "handling_status" | "received_at" | "error_detail">;

const platformLabel = (p: string | null) => (p ? PLATFORM_LABELS[p] ?? p : "—");
const eventName = (e: Pick<HookRow, "event_type" | "field">) => (e.field ? `${e.event_type} · ${e.field}` : e.event_type);
const statusBadge = (status: string) => html`<span class="badge tone-${WEBHOOK_STATUS_TONE[status] ?? "neutral"}">${status}</span>`;
/** Statuses of deliveries tied to a channel; the endpoint-level ones never have a channel and stay on /webhooks. */
const CHANNEL_STATUSES = WEBHOOK_STATUS_LEGEND.map(([status]) => status).filter((s) => !(WEBHOOK_ENDPOINT_STATUSES as readonly string[]).includes(s));

/** Find the display name a platform attached to an id anywhere in the raw payload (Meta nests it as `{ id, name }`). */
function findNameForId(node: unknown, id: string, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  if (o.id === id && typeof o.name === "string" && o.name.trim()) return o.name;
  for (const v of Object.values(o)) {
    const found = findNameForId(v, id, depth + 1);
    if (found) return found;
  }
  return null;
}

/** A "From"/"To" row that leads with the person's name and shows the raw id quietly beside it. */
function identity(label: string, id: string | null, rawPayload: unknown) {
  if (!id) return "";
  const name = findNameForId(rawPayload, id);
  return html`<dt>${label}</dt><dd>${name ? html`<strong>${name}</strong> <code class="mono">${id}</code>` : html`<code class="mono">${id}</code>`}</dd>`;
}

const fact = (label: string, value: unknown) =>
  value === null || value === undefined || value === "" ? "" : html`<dt>${label}</dt><dd>${typeof value === "boolean" ? (value ? "yes" : "no") : String(value)}</dd>`;

function hookDetail(e: typeof webhookEvents.$inferSelect, channelName: string | null) {
  const triggered: Array<[string, string]> = [];
  if (e.conversation_id) triggered.push(["Conversation", e.conversation_id]);
  if (e.message_id) triggered.push(["Message", e.message_id]);
  if (e.comment_log_id) triggered.push(["Comment action", e.comment_log_id]);
  if (e.outbound_delivery_id) triggered.push(["Outbound reply", e.outbound_delivery_id]);
  if (e.contact_id) triggered.push(["Contact", e.contact_id]);
  const nothing = e.handling_status === "recorded" ? "Nothing: stored for engagement only." : e.handling_status === "fired" ? "A reply was sent or queued." : "Nothing was triggered.";
  return {
    title: html`${eventName(e)} ${statusBadge(e.handling_status)}`,
    body: html`<dl class="dl-facts">
        ${fact("Channel", channelName)}
        <dt>Platform</dt><dd>${platformLabel(e.platform)}</dd>
        <dt>Received</dt><dd>${localTime(e.received_at)}</dd>
        ${e.handled_at ? html`<dt>Handled</dt><dd>${localTime(e.handled_at)}</dd>` : ""}
        ${identity("From", e.sender_id, e.raw)}${identity("To", e.recipient_id, e.raw)}
        ${fact("Message id", e.platform_message_id)}${fact("Echo", e.is_echo || null)}${fact("Event key", e.event_key)}
        ${e.error_detail ? html`<dt>Error</dt><dd class="dl-problem">${e.error_detail}</dd>` : ""}
      </dl>
      <p class="dl-label">What was triggered</p>
      ${triggered.length
        ? html`<dl class="dl-facts">${triggered.map(([k, v]) => html`<dt>${k}</dt><dd><code class="mono">${v}</code></dd>`)}</dl>`
        : html`<p class="muted">${nothing}</p>`}
      <p class="dl-label">Raw payload</p><pre class="dl-json">${redactSecrets(JSON.stringify(e.raw, null, 2))}</pre>
      ${e.conversation_id ? html`<a class="btn btn-secondary btn-sm dl-action" href="/inbox/${e.conversation_id}">Open conversation</a>` : ""}`,
  };
}

export async function renderWebhooksLog(workspaceId: string, url: string, path: string) {
  const state = readListState(url, ["status", "platform", "channel", "event"], ["source"]);
  const mine = db.select({ id: channels.id }).from(channels).where(eq(channels.workspace_id, workspaceId));
  const scope = inArray(webhookEvents.channel_id, mine);
  const like = (col: AnyColumn, pat: string) => sql`${col} ILIKE ${pat}`;
  const pat = containsPattern(state.q);
  const search = state.q
    ? or(
        like(webhookEvents.event_type, pat), like(webhookEvents.field, pat), like(webhookEvents.error_detail, pat),
        inArray(webhookEvents.channel_id, db.select({ id: channels.id }).from(channels).where(and(
          eq(channels.workspace_id, workspaceId), or(like(channels.display_name, pat), like(channels.username, pat)),
        ))),
      )
    : undefined;
  const f = state.filters;
  const status = f.status && (CHANNEL_STATUSES as string[]).includes(f.status) ? sql`${webhookEvents.handling_status} = ${f.status}` : undefined;
  if (!status) delete f.status;
  const withoutStatus = and(
    scope, search,
    f.platform ? sql`${webhookEvents.platform} = ${f.platform}` : undefined,
    isUuid(f.channel) ? eq(webhookEvents.channel_id, f.channel!) : undefined,
    f.event ? eq(webhookEvents.event_type, f.event) : undefined,
  );

  const [page, statusCounts, platforms, eventTypes, myChannels, opened] = await Promise.all([
    listPage<HookRow>({
      table: webhookEvents, where: and(withoutStatus, status), time: webhookEvents.received_at, id: webhookEvents.id,
      limit: PAGE_SIZE, after: state.after, before: state.before,
      keyOf: (e) => ({ at: e.received_at, id: e.id }),
      fetch: (q) => db.select({
        id: webhookEvents.id, channel_id: webhookEvents.channel_id, platform: webhookEvents.platform, event_type: webhookEvents.event_type,
        field: webhookEvents.field, handling_status: webhookEvents.handling_status, received_at: webhookEvents.received_at, error_detail: webhookEvents.error_detail,
      }).from(webhookEvents).where(q.where).orderBy(...q.orderBy).limit(q.limit),
    }),
    countBy(webhookEvents, webhookEvents.handling_status, withoutStatus),
    countBy(webhookEvents, webhookEvents.platform, scope),
    countBy(webhookEvents, webhookEvents.event_type, scope),
    db.select({ id: channels.id, name: sql<string>`coalesce(${channels.display_name}, ${channels.username}, ${channels.platform_id})` }).from(channels).where(eq(channels.workspace_id, workspaceId)),
    isUuid(state.open) ? db.query.webhookEvents.findFirst({ where: and(scope, eq(webhookEvents.id, state.open)) }) : undefined,
  ]);
  const channelName = new Map(myChannels.map((c) => [c.id, c.name] as const));
  const nameOf = (e: Pick<HookRow, "channel_id">) => (e.channel_id ? channelName.get(e.channel_id) ?? null : null);

  const columns: ListColumn<HookRow>[] = [
    { label: "Event", width: "26%", main: true, cell: eventName },
    { label: "Channel", width: "22%", cell: (e) => nameOf(e) ?? "—" },
    { label: "Status", width: "13%", cell: (e) => statusBadge(e.handling_status) },
    { label: "Detail", width: "27%", cell: (e) => (e.error_detail ? html`<span class="dl-problem">${e.error_detail}</span>` : "—") },
    { label: "When", width: "12%", cell: (e) => html`<span class="dl-when" data-local-title="${e.received_at.toISOString()}" title="${fmtDate(e.received_at)}">${timeAgo(e.received_at)}</span>` },
  ];

  return dataList<HookRow>({
    path, noun: "events", state, searchPlaceholder: "Search event, channel, error…",
    chips: {
      key: "status", label: "Status",
      all: [...statusCounts.values()].reduce((a, b) => a + b, 0),
      options: CHANNEL_STATUSES.filter((s) => statusCounts.has(s)).map((s) => ({ value: s, label: s, count: statusCounts.get(s)! })),
    },
    selects: [
      { key: "platform", label: "Platform", options: [...platforms.keys()].sort().map((p) => ({ value: p, label: platformLabel(p) })) },
      { key: "channel", label: "Channel", options: myChannels.map((c) => ({ value: c.id, label: c.name })) },
      { key: "event", label: "Event", options: [...eventTypes.keys()].sort().map((t) => ({ value: t, label: t })) },
    ],
    columns, rows: page.rows, rowId: (e) => e.id,
    sub: (e) => html`${nameOf(e) ?? "—"} · ${timeAgo(e.received_at)}${e.error_detail ? ` · ${e.error_detail}` : ""}`,
    page,
    detail: opened ? hookDetail(opened, nameOf(opened)) : undefined,
    emptyTitle: "No webhook events yet",
    emptyBody: "They appear here once your connected accounts send activity: messages, comments and reactions.",
  });
}
