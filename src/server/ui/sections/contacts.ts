import { ApiError } from "@/lib/api/response";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { and, asc, eq, exists, ilike, like, or, sql, type SQL } from "drizzle-orm";
import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels, contactChannels, contactTags, contacts, tags } from "@/db/schema";
import { getInstanceLicense } from "@/lib/license/gate";
import { listBrands } from "@/lib/brands/service";
import { containsPattern, countBy, listPage } from "@/lib/list-page";
import { isUuid } from "@/lib/api/identifiers";
import { t } from "@/lib/i18n";
import { dataList, readListState, type ListColumn } from "../components/data-list";
import { fmtDate, localTime } from "../components/format";
import { PLATFORM_LABELS } from "../components/platform";
import { isHtmx } from "../components/toast";
import { timeAgo } from "../components/time";
import { dashboardDoc } from "../layout";

const PAGE_SIZE = 50;

type Html = ReturnType<typeof html>;
type ChannelLink = { platform_sender_id: string; platform_username: string | null; channel: { platform: string; display_name: string | null } };
type Row = Pick<typeof contacts.$inferSelect, "id" | "display_name" | "email" | "is_subscribed" | "last_interaction_at"> & { contact_channels: ChannelLink[] };

const platformName = (p: string) => PLATFORM_LABELS[p] ?? p;
const nameOf = (c: Row) => c.display_name ?? c.contact_channels[0]?.platform_username ?? c.contact_channels[0]?.platform_sender_id ?? "Unknown";
const handleOf = (c: Row) => { const u = c.contact_channels[0]?.platform_username; return u ? `@${u}` : (c.email ?? ""); };
const statusExpr = sql<string>`case when ${contacts.is_subscribed} then 'subscribed' else 'unsubscribed' end`;
const STATUSES = [{ value: "subscribed", label: "Subscribed" }, { value: "unsubscribed", label: "Unsubscribed" }];

const viaChannel = (cond: SQL | undefined) =>
  exists(db.select({ x: sql`1` }).from(contactChannels).innerJoin(channels, eq(channels.id, contactChannels.channel_id)).where(and(eq(contactChannels.contact_id, contacts.id), cond)));

function searchWhere(q: string): SQL | undefined {
  if (!q) return undefined;
  const pat = containsPattern(q);
  return or(
    ilike(contacts.display_name, pat),
    ilike(contacts.email, pat),
    exists(db.select({ x: sql`1` }).from(contactChannels).where(and(eq(contactChannels.contact_id, contacts.id), or(ilike(contactChannels.platform_username, pat), like(contactChannels.platform_sender_id, pat))))),
  );
}

const channelBadges = (links: ChannelLink[]) =>
  html`<span class="pill-row">${links.map((cc) => html`<span class="badge" title="${cc.channel.display_name ?? cc.channel.platform}">${platformName(cc.channel.platform)}${cc.platform_username ? html` · @${cc.platform_username}` : ""}</span>`)}</span>`;
const statusBadge = (c: Pick<Row, "is_subscribed">) => (c.is_subscribed ? html`<span class="muted">Subscribed</span>` : html`<span class="badge tone-bad">Unsubscribed</span>`);

const COLUMNS: ListColumn<Row>[] = [
  { label: "Contact", width: "32%", main: true, cell: (c) => html`<b>${nameOf(c)}</b>${c.email ? html`<div class="muted">${c.email}</div>` : ""}` },
  { label: "Channels", width: "30%", cell: (c) => channelBadges(c.contact_channels) },
  { label: "Status", width: "16%", cell: statusBadge },
  { label: "Last seen", width: "22%", cell: (c) => (c.last_interaction_at ? html`<span class="dl-when" data-local-title="${c.last_interaction_at.toISOString()}" title="${fmtDate(c.last_interaction_at)}">${timeAgo(c.last_interaction_at)}</span>` : html`<span class="muted">Never</span>`) },
];

async function openedContact(workspaceId: string, id: string) {
  if (!isUuid(id)) return undefined;
  const c = await db.query.contacts.findFirst({
    where: and(eq(contacts.workspace_id, workspaceId), eq(contacts.id, id)),
    columns: { id: true, display_name: true, email: true, phone: true, is_subscribed: true, last_interaction_at: true, created_at: true },
    with: { contact_channels: { columns: { platform_sender_id: true, platform_username: true }, with: { channel: { columns: { platform: true, display_name: true } } } } },
  });
  if (!c) return undefined;
  const tagNames = await db.select({ name: tags.name }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tag_id)).where(eq(contactTags.contact_id, id)).orderBy(asc(tags.name));
  return {
    title: nameOf(c),
    body: html`<dl class="dl-facts">
        ${c.email ? html`<dt>Email</dt><dd>${c.email}</dd>` : ""}
        ${c.phone ? html`<dt>Phone</dt><dd>${c.phone}</dd>` : ""}
        <dt>Status</dt><dd>${statusBadge(c)}</dd>
        <dt>Channels</dt><dd>${c.contact_channels.length ? channelBadges(c.contact_channels) : "—"}</dd>
        <dt>Tags</dt><dd>${tagNames.length ? html`<span class="pill-row">${tagNames.map((tg) => html`<span class="badge">${tg.name}</span>`)}</span>` : "—"}</dd>
        <dt>Last seen</dt><dd>${c.last_interaction_at ? localTime(c.last_interaction_at) : "Never"}</dd>
        <dt>First seen</dt><dd>${localTime(c.created_at)}</dd>
      </dl>
      <a class="btn btn-secondary btn-sm dl-action" href="/inbox?contact=${c.id}">Open conversations</a>`,
  };
}

async function renderContacts(workspaceId: string, url: string, multiBrand: boolean) {
  const state = readListState(url, ["status", "brand", "channel", "platform", "tag"]);
  const f = state.filters;
  if (!STATUSES.some((s) => s.value === f.status)) delete f.status;
  if (f.channel && !isUuid(f.channel)) delete f.channel;
  if (!multiBrand) delete f.brand;

  const [chans, brandList, tagList] = await Promise.all([
    db.select({ id: channels.id, platform: channels.platform, display_name: channels.display_name, username: channels.username }).from(channels).where(eq(channels.workspace_id, workspaceId)).orderBy(asc(channels.created_at)),
    multiBrand ? listBrands(workspaceId) : [],
    db.select({ name: tags.name }).from(tags).where(eq(tags.workspace_id, workspaceId)).orderBy(asc(tags.name)),
  ]);
  const platforms = [...new Set(chans.map((ch) => ch.platform))];
  if (f.platform && !platforms.includes(f.platform as (typeof platforms)[number])) delete f.platform;

  const withoutStatus = and(
    eq(contacts.workspace_id, workspaceId),
    searchWhere(state.q),
    f.channel ? viaChannel(eq(contactChannels.channel_id, f.channel)) : f.platform ? viaChannel(eq(channels.platform, f.platform as (typeof platforms)[number])) : undefined,
    f.brand ? viaChannel(eq(channels.brand_key, f.brand)) : undefined,
    f.tag ? exists(db.select({ x: sql`1` }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tag_id)).where(and(eq(contactTags.contact_id, contacts.id), eq(tags.name, f.tag), eq(tags.workspace_id, workspaceId)))) : undefined,
  );
  const where = and(withoutStatus, f.status ? sql`${statusExpr} = ${f.status}` : undefined);

  const [page, counts, opened] = await Promise.all([
    listPage<Row>({
      table: contacts, where, time: contacts.last_interaction_at, nullable: true, id: contacts.id, limit: PAGE_SIZE, after: state.after, before: state.before,
      keyOf: (c) => ({ at: c.last_interaction_at, id: c.id }),
      fetch: (q) => db.query.contacts.findMany({
        where: q.where, orderBy: q.orderBy, limit: q.limit,
        columns: { id: true, display_name: true, email: true, is_subscribed: true, last_interaction_at: true },
        with: { contact_channels: { columns: { platform_sender_id: true, platform_username: true }, limit: 3, with: { channel: { columns: { platform: true, display_name: true } } } } },
      }),
    }),
    countBy(contacts, statusExpr, withoutStatus),
    openedContact(workspaceId, state.open),
  ]);

  if (state.open && !opened) throw new ApiError("not_found", "Not found", 404);

  const select = (key: string, label: string, options: Array<{ value: string; label: string }>) => (options.length > 1 || f[key] ? [{ key, label, options }] : []);
  return dataList<Row>({
    path: "/contacts",
    noun: "contacts",
    state,
    searchPlaceholder: "Search name, email, handle…",
    chips: { key: "status", label: "Status", all: [...counts.values()].reduce((a, b) => a + b, 0), options: STATUSES.map((s) => ({ ...s, count: counts.get(s.value) ?? 0 })) },
    selects: [
      ...select("brand", "Brand", brandList.map((b) => ({ value: b.key, label: b.name }))),
      ...select("channel", "Channel", chans.map((ch) => ({ value: ch.id, label: `${platformName(ch.platform)} · ${ch.display_name ?? ch.username ?? ch.id}` }))),
      ...select("platform", "Platform", platforms.map((p) => ({ value: p, label: platformName(p) }))),
      ...select("tag", "Tag", tagList.map((tg) => ({ value: tg.name, label: tg.name }))),
    ],
    columns: COLUMNS,
    rows: page.rows,
    rowId: (c) => c.id,
    sub: (c) => html`${handleOf(c) ? `${handleOf(c)} · ` : ""}${c.last_interaction_at ? timeAgo(c.last_interaction_at) : "never seen"}`,
    page,
    detail: opened,
    emptyTitle: "No contacts yet",
    emptyBody: "Connect a channel and start receiving messages — everyone who writes in shows up here.",
  });
}

/** `proLock` renders the shared upsell for instances without the contacts CRM. */
export function registerContacts(r: Hono, guard: MiddlewareHandler, proLock: (title: string, body: Html, upgradeUrl: string) => Html | Promise<HtmlEscapedString>): void {
  r.get("/contacts", guard, async (c: Context) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return isHtmx(c) ? c.body(null, 401, { "HX-Redirect": "/login" }) : c.redirect("/login");
    c.header("Cache-Control", "private, no-store, no-transform");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    const title = t("title.suffix", { section: "Contacts" });
    if (!features.has("contacts_crm")) {
      return c.html(dashboardDoc(title, "/contacts", await proLock("Contacts", html`The contacts CRM is a PRO feature.`, upgradeUrl), features, products));
    }
    return c.html(
      dashboardDoc(
        title,
        "/contacts",
        html`<div class="page">
          <h1>Contacts</h1>
          <p class="muted">Everyone who has messaged your connected pages. Contacts are assigned to a channel automatically.</p>
          ${await renderContacts(a.workspaceId, c.req.url, features.has("multi_brand"))}
        </div>`,
        features,
        products,
      ),
    );
  });
}
