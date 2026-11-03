import { html } from "hono/html";
import { and, eq, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { events } from "@/db/schema";
import { containsPattern, countBy, listPage } from "@/lib/list-page";
import { isUuid } from "@/lib/api/identifiers";
import { redactSecrets } from "@/lib/redact";
import { dataList, readListState, type ListColumn, type ListState } from "../components/data-list";
import { fmtDate, localTime } from "../components/format";
import { PLATFORM_LABELS } from "../components/platform";
import { timeAgo } from "../components/time";
import type { Tone } from "../components/status";
import { postPreview } from "../components/post-preview";
import { deliveryPostCard, type PostCardData } from "@/lib/posts/preview";

const PAGE_SIZE = 50;

/** Friendly label + tone for each event type (the raw type is the fallback). */
export const EVENT_META: Record<string, { label: string; tone: Tone }> = {
  "channel.created": { label: "Channel connected", tone: "ok" },
  "channel.reconnected": { label: "Channel reconnected", tone: "ok" },
  "channel.needs_reauth": { label: "Channel needs re-auth", tone: "bad" },
  "post.published": { label: "Post published", tone: "ok" },
  "post.first_comment": { label: "First comment posted", tone: "ok" },
  "post.held": { label: "Post held", tone: "warn" },
  "post.failed": { label: "Post failed", tone: "bad" },
  "post.unknown": { label: "Post error", tone: "bad" },
  "source.connected": { label: "Source connected", tone: "ok" },
  "source.synced": { label: "Source synced", tone: "info" },
  "source.needs_reauth": { label: "Source needs re-auth", tone: "bad" },
  "source.data_access_expiring": { label: "Data access expiring", tone: "warn" },
  "contact.created": { label: "Contact created", tone: "neutral" },
  "contact.updated": { label: "Contact updated", tone: "neutral" },
  "contact.erased": { label: "Contact erased", tone: "neutral" },
  "conversation.updated": { label: "Conversation updated", tone: "neutral" },
  "message.received": { label: "Message received", tone: "info" },
  "comment.received": { label: "Comment received", tone: "info" },
};

const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? p;

const typesWithTone = (tone: Tone) => Object.keys(EVENT_META).filter((type) => EVENT_META[type]!.tone === tone);
const PROBLEM_TYPES = typesWithTone("bad");
const WARNING_TYPES = typesWithTone("warn");

const SEVERITIES = [
  { value: "problems", label: "Problems", where: () => inArray(events.type, PROBLEM_TYPES), holds: (type: string) => PROBLEM_TYPES.includes(type) },
  { value: "warnings", label: "Warnings", where: () => inArray(events.type, WARNING_TYPES), holds: (type: string) => WARNING_TYPES.includes(type) },
  { value: "normal", label: "Normal", where: () => notInArray(events.type, [...PROBLEM_TYPES, ...WARNING_TYPES]), holds: (type: string) => !PROBLEM_TYPES.includes(type) && !WARNING_TYPES.includes(type) },
];

type EventRow = Pick<typeof events.$inferSelect, "id" | "type" | "subject_type" | "subject_id" | "payload" | "created_at">;
type Payload = { displayName?: string; platform?: string; error?: string; reason?: string; providerHandle?: string; deliveryId?: string };

const payloadOf = (e: EventRow) => (e.payload ?? {}) as Payload;
const subjectOf = (e: EventRow) => payloadOf(e).displayName ?? (e.subject_type ? `${e.subject_type}${e.subject_id ? ` · ${e.subject_id}` : ""}` : "—");
const areaExpr = sql<string>`split_part(${events.type}, '.', 1)`;
const platformExpr = sql<string>`${events.payload}->>'platform'`;
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function searchWhere(q: string): SQL | undefined {
  if (!q) return undefined;
  const pat = containsPattern(q);
  const needle = q.toLowerCase();
  const byLabel = Object.keys(EVENT_META).filter((type) => EVENT_META[type]!.label.toLowerCase().includes(needle));
  const inPayload = (key: string) => sql`${events.payload}->>${key} ILIKE ${pat}`;
  return or(
    sql`${events.type} ILIKE ${pat}`,
    sql`${events.subject_id} ILIKE ${pat}`,
    inPayload("displayName"), inPayload("error"), inPayload("reason"), inPayload("providerHandle"),
    byLabel.length ? inArray(events.type, byLabel) : undefined,
  );
}

function eventBadge(e: Pick<EventRow, "type">) {
  const meta = EVENT_META[e.type];
  return html`<span class="badge tone-${meta?.tone ?? "neutral"}">${meta?.label ?? e.type}</span>`;
}

function when(at: Date) {
  return html`<span class="dl-when" title="${fmtDate(at)}">${timeAgo(at)}</span>`;
}

/** Where the event's subject can be opened. Posts are skipped: their subject id may be a delivery. */
function subjectLink(e: EventRow) {
  if (e.subject_type === "conversation" && isUuid(e.subject_id)) return { href: `/inbox/${e.subject_id}`, label: "Open conversation" };
  if (e.subject_type === "channel") return { href: "/channels", label: "Open channels" };
  return null;
}

/** post.published / post.failed point at a delivery: show the post itself (POSTPREVIEW1). */
async function postCardFor(workspaceId: string, e: EventRow): Promise<PostCardData | undefined> {
  const id = payloadOf(e).deliveryId;
  return e.type.startsWith("post.") && isUuid(id) ? deliveryPostCard(workspaceId, id) : undefined;
}

function eventDetail(e: EventRow, card?: PostCardData) {
  const p = payloadOf(e);
  // `channels` holds platform sender ids, which this log has never displayed.
  const { workspaceId: _ws, channels: _ids, ...shown } = (e.payload ?? {}) as Record<string, unknown>;
  const problem = p.error ?? p.reason;
  const link = subjectLink(e);
  return {
    title: eventBadge(e),
    body: html`${card ? postPreview(card) : ""}<dl class="dl-facts">
        <dt>Subject</dt><dd>${subjectOf(e)}</dd>
        ${p.platform ? html`<dt>Platform</dt><dd>${platformLabel(p.platform)}</dd>` : ""}
        <dt>When</dt><dd>${localTime(e.created_at)}</dd>
        <dt>Type</dt><dd class="mono">${e.type}</dd>
        ${problem ? html`<dt>Detail</dt><dd class="dl-problem">${problem}</dd>` : p.providerHandle ? html`<dt>Detail</dt><dd>${p.providerHandle}</dd>` : ""}
      </dl>
      ${Object.keys(shown).length ? html`<p class="dl-label">Payload</p><pre class="dl-json">${redactSecrets(JSON.stringify(shown, null, 2))}</pre>` : ""}
      ${link ? html`<a class="btn btn-secondary btn-sm dl-action" href="${link.href}">${link.label}</a>` : ""}`,
  };
}

const COLUMNS: ListColumn<EventRow>[] = [
  { label: "Event", width: "26%", main: true, cell: eventBadge },
  { label: "Subject", width: "26%", cell: subjectOf },
  { label: "Platform", width: "12%", cell: (e) => { const p = payloadOf(e).platform; return p ? platformLabel(p) : "—"; } },
  { label: "Detail", width: "26%", cell: (e) => { const p = payloadOf(e); return p.error ?? p.reason ?? p.providerHandle ?? "—"; } },
  { label: "When", width: "10%", cell: (e) => when(e.created_at) },
];

/** The events source of Activity; `path` is the list address the links and filter form point back to. */
export async function renderEvents(workspaceId: string, url: string, path: string) {
  const state: ListState = readListState(url, ["severity", "area", "platform"], ["source"]);
  const severity = SEVERITIES.find((sv) => sv.value === state.filters.severity);
  if (!severity) delete state.filters.severity;

  const scope = eq(events.workspace_id, workspaceId);
  const search = searchWhere(state.q);
  const area = state.filters.area ? sql`${areaExpr} = ${state.filters.area}` : undefined;
  const platform = state.filters.platform ? sql`${platformExpr} = ${state.filters.platform}` : undefined;
  const withoutSeverity = and(scope, search, area, platform);
  const where = and(withoutSeverity, severity?.where());

  const [page, typeCounts, chipCounts, platforms, opened] = await Promise.all([
    listPage<EventRow>({
      table: events, where, time: events.created_at, id: events.id, limit: PAGE_SIZE, after: state.after, before: state.before,
      keyOf: (e) => ({ at: e.created_at, id: e.id }),
      fetch: (q) => db.select({
        id: events.id, type: events.type, subject_type: events.subject_type, subject_id: events.subject_id, payload: events.payload, created_at: events.created_at,
      }).from(events).where(q.where).orderBy(...q.orderBy).limit(q.limit),
    }),
    countBy(events, events.type, scope),
    countBy(events, events.type, withoutSeverity),
    countBy(events, platformExpr, scope),
    isUuid(state.open)
      ? db.query.events.findFirst({
          where: and(scope, eq(events.id, state.open)),
          columns: { id: true, type: true, subject_type: true, subject_id: true, payload: true, created_at: true },
        })
      : undefined,
  ]);

  const counts = [...chipCounts];
  const areas = [...new Set([...typeCounts.keys()].map((type) => type.split(".")[0]!))].sort();

  return dataList<EventRow>({
    path,
    noun: "events",
    state,
    searchPlaceholder: "Search event or subject…",
    chips: {
      key: "severity",
      label: "Severity",
      all: counts.reduce((sum, [, n]) => sum + n, 0),
      options: SEVERITIES.map((sv) => ({
        value: sv.value,
        label: sv.label,
        count: counts.reduce((sum, [type, n]) => (sv.holds(type) ? sum + n : sum), 0),
      })),
    },
    selects: [
      { key: "area", label: "Area", options: areas.map((a) => ({ value: a, label: titleCase(a) })) },
      { key: "platform", label: "Platform", options: [...platforms.keys()].sort().map((p) => ({ value: p, label: platformLabel(p) })) },
    ],
    columns: COLUMNS,
    rows: page.rows,
    rowId: (e) => e.id,
    sub: (e) => html`${subjectOf(e)} · ${timeAgo(e.created_at)}`,
    page,
    detail: opened ? eventDetail(opened, await postCardFor(workspaceId, opened)) : undefined,
    emptyTitle: "No events yet",
    emptyBody: "Activity shows up here as channels connect, posts publish, and tokens expire.",
  });
}
