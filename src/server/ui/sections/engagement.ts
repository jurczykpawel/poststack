import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels, contacts, messageReactions, messages } from "@/db/schema";
import { getInstanceLicense } from "@/lib/license/gate";
import { containsPattern, listPage } from "@/lib/list-page";
import { isUuid } from "@/lib/api/identifiers";
import { listBrands } from "@/lib/brands/service";
import { t } from "@/lib/i18n";
import { dataList, listHref, readListState, type ListColumn, type ListOption, type ListState } from "../components/data-list";
import { fmtCount, fmtDate, localTime } from "../components/format";
import { icon } from "../components/icons";
import { PLATFORM_LABELS } from "../components/platform";
import { timeAgo } from "../components/time";
import { dashboardDoc } from "../layout";
import { countPosts, linkedPosts, parsePostRowId, postFacts, postPage, postRowId, recentReactors, type LinkedPost, type PostFacts, type PostKey } from "./engagement-data";

type Html = ReturnType<typeof html>;
type Channel = { id: string; platform: string; display_name: string | null; username: string | null; brand_key: string | null };

const PAGE_SIZE = 50;
const WHO_LIMIT = 20;
const POST_PATH = "/engagement";
const MESSAGE_PATH = "/engagement/messages";
const UNASSIGNED = "__unassigned__";
const REACTION_EMOJI: Record<string, string> = { like: "👍", love: "❤️", care: "🥰", haha: "😆", wow: "😮", sad: "😢", angry: "😠" };

const platformName = (p: string | null | undefined) => (p ? PLATFORM_LABELS[p] ?? p : "—");
const channelName = (c: Pick<Channel, "id" | "display_name" | "username"> | undefined) => c?.display_name ?? c?.username ?? "—";
const when = (at: Date) => html`<span class="dl-when" title="${fmtDate(at)}">${timeAgo(at)}</span>`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

/** The channels the brand/account filters leave: null = all, [] = nothing. The account wins over the brand. */
function readScope(state: ListState, chans: Channel[]): string[] | null {
  for (const k of ["brand", "channel"]) if (state.filters[k] === "all") delete state.filters[k]; // links from before this list
  const { channel, brand } = state.filters;
  if (channel) return chans.some((c) => c.id === channel) ? [channel] : [];
  if (brand) return chans.filter((c) => (c.brand_key ?? UNASSIGNED) === brand).map((c) => c.id);
  return null;
}

async function filterSelects(workspaceId: string, chans: Channel[]) {
  const brands = await listBrands(workspaceId);
  const brandOptions: ListOption[] = brands.map((b) => ({ value: b.key, label: b.name }));
  if (chans.some((c) => !c.brand_key)) brandOptions.push({ value: UNASSIGNED, label: "Unassigned" });
  return [
    { key: "brand", label: "Brand", options: brandOptions },
    { key: "channel", label: "Account", options: chans.map((c) => ({ value: c.id, label: `${platformName(c.platform)} · ${channelName(c)}` })) },
  ];
}

/** The two views. Inside the list, so switching keeps the filters and swaps without a reload. */
function viewTabs(state: ListState, current: string, posts: number, reactions: number): Html {
  const fresh: ListState = { q: "", filters: state.filters, after: "", before: "", open: "" };
  const tab = (path: string, label: string, n: number) =>
    html`<a class="dl-chip" href="${listHref(path, fresh)}" ${current === path ? html`aria-current="true"` : ""}>${label} <b>${fmtCount(n)}</b></a>`;
  return html`<nav class="dl-chips" aria-label="View">${tab(POST_PATH, "Posts", posts)}${tab(MESSAGE_PATH, "Message reactions", reactions)}</nav>`;
}

const breakdown = (f: PostFacts | undefined) =>
  html`<span class="pill-row">${(f?.byType ?? []).map((b) => html`<span class="small" title="${b.type}">${REACTION_EMOJI[b.type] ?? b.type} ${fmtCount(b.n)}</span> `)}</span>`;

type PostRow = PostKey & { facts?: PostFacts; linked?: LinkedPost; channel?: Channel };

const postLabel = (r: PostRow) =>
  r.linked?.text ? clip(r.linked.text, 140) : html`<span class="mono">${r.postId}</span>`;

const POST_COLUMNS: ListColumn<PostRow>[] = [
  { label: "Post", width: "40%", main: true, cell: postLabel },
  { label: "Channel", width: "18%", cell: (r) => channelName(r.channel) },
  { label: "Reactions", width: "10%", num: true, cell: (r) => fmtCount(r.facts?.total ?? 0) },
  { label: "Breakdown", width: "20%", cell: (r) => breakdown(r.facts) },
  { label: "Latest", width: "12%", cell: (r) => (r.facts ? when(r.facts.lastAt) : "—") },
];

async function postDetail(workspaceId: string, key: PostKey, chans: Channel[]) {
  const channel = chans.find((c) => c.id === key.channelId);
  if (!channel) return undefined;
  const [facts, linked, who] = await Promise.all([
    postFacts(workspaceId, [key]).then((m) => m.get(postRowId(key))),
    linkedPosts(workspaceId, [key.postId]).then((m) => m.get(key.postId)),
    recentReactors(workspaceId, key, WHO_LIMIT),
  ]);
  if (!facts) return undefined;
  const url = safeUrl(linked?.url) ?? (channel.platform === "facebook" ? `https://www.facebook.com/${key.postId}` : null);
  const others = facts.total - who.length;
  return {
    title: linked?.text ? clip(linked.text, 280) : "Post made outside PostStack",
    body: html`<dl class="dl-facts">
        <dt>Channel</dt><dd>${platformName(channel.platform)} · ${channelName(channel)}</dd>
        <dt>Reactions</dt><dd>${fmtCount(facts.total)}</dd>
        <dt>Breakdown</dt><dd>${breakdown(facts)}</dd>
        <dt>Latest</dt><dd>${localTime(facts.lastAt)}</dd>
        <dt>Who</dt><dd>${who.length ? `${who.join(", ")}${others > 0 ? ` and ${fmtCount(others)} more` : ""}` : "Names are removed from older reactions"}</dd>
        <dt>Post id</dt><dd class="mono">${key.postId}</dd>
      </dl>
      ${url ? html`<a class="btn btn-secondary btn-sm dl-action" href="${url}" target="_blank" rel="noopener">View on ${platformName(channel.platform)}</a>` : ""}
      ${linked?.contentId ? html`<a class="btn btn-secondary btn-sm dl-action" href="/content/${linked.contentId}">Open in Content</a>` : ""}`,
  };
}

function messageScope(workspaceId: string, scope: string[] | null): SQL | undefined {
  return and(eq(messageReactions.workspace_id, workspaceId), scope ? inArray(messageReactions.channel_id, scope) : undefined);
}

async function countMessageReactions(where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(messageReactions).where(where);
  return row?.n ?? 0;
}

async function renderPosts(workspaceId: string, url: string, chans: Channel[]) {
  const state = readListState(url, ["brand", "channel"]);
  const scope = readScope(state, chans);
  const openKey = parsePostRowId(state.open);
  const [page, selects, reactions, allPosts, detail] = await Promise.all([
    postPage({ workspaceId, channelIds: scope, q: state.q, limit: PAGE_SIZE, after: state.after, before: state.before }),
    filterSelects(workspaceId, chans),
    countMessageReactions(messageScope(workspaceId, scope)),
    state.q ? countPosts(workspaceId, scope) : null,
    openKey ? postDetail(workspaceId, openKey, chans) : undefined,
  ]);
  const [facts, linked] = await Promise.all([postFacts(workspaceId, page.rows), linkedPosts(workspaceId, page.rows.map((k) => k.postId))]);
  const rows: PostRow[] = page.rows.map((k) => ({ ...k, facts: facts.get(postRowId(k)), linked: linked.get(k.postId), channel: chans.find((c) => c.id === k.channelId) }));
  return dataList<PostRow>({
    path: POST_PATH,
    noun: "posts",
    state,
    searchPlaceholder: "Search post text or channel…",
    tabs: viewTabs(state, POST_PATH, allPosts ?? page.total, reactions),
    selects,
    columns: POST_COLUMNS,
    rows,
    rowId: postRowId,
    sub: (r) => html`${channelName(r.channel)} · ${fmtCount(r.facts?.total ?? 0)} reactions`,
    page,
    detail,
    emptyTitle: "No post reactions yet",
    emptyBody: "Reactions on your Facebook posts will show up here.",
  });
}

const messageRow = {
  id: messageReactions.id, conversationId: messageReactions.conversation_id, type: messageReactions.reaction_type, emoji: messageReactions.emoji,
  createdAt: messageReactions.created_at, who: contacts.display_name, channelId: messageReactions.channel_id, text: messages.text,
};
type MessageRow = { id: string; conversationId: string; type: string; emoji: string | null; createdAt: Date; who: string | null; channelId: string; text: string | null };

const selectMessageRows = () =>
  db.select(messageRow).from(messageReactions)
    .leftJoin(contacts, eq(contacts.id, messageReactions.contact_id))
    .leftJoin(messages, and(eq(messages.conversation_id, messageReactions.conversation_id), eq(messages.platform_message_id, messageReactions.reacted_mid)));

const reactionBadge = (r: MessageRow) => html`<span class="badge" title="${r.type}">${r.emoji ?? REACTION_EMOJI[r.type] ?? "💬"} ${r.type}</span>`;

function messageSearch(workspaceId: string, q: string): SQL | undefined {
  if (!q) return undefined;
  const pat = containsPattern(q);
  return or(
    sql`${messageReactions.reaction_type} ILIKE ${pat}`,
    sql`${messageReactions.contact_id} IN (SELECT ${contacts.id} FROM ${contacts} WHERE ${contacts.workspace_id} = ${workspaceId} AND ${contacts.display_name} ILIKE ${pat})`,
    sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversation_id} = ${messageReactions.conversation_id} AND ${messages.platform_message_id} = ${messageReactions.reacted_mid} AND ${messages.text} ILIKE ${pat})`,
  );
}

async function renderMessages(workspaceId: string, url: string, chans: Channel[]) {
  const state = readListState(url, ["brand", "channel"]);
  const scope = readScope(state, chans);
  const scoped = messageScope(workspaceId, scope);
  const nameOf = (id: string) => chans.find((c) => c.id === id);
  const columns: ListColumn<MessageRow>[] = [
    { label: "Who", width: "22%", main: true, cell: (r) => r.who ?? "Someone" },
    { label: "Reaction", width: "14%", cell: reactionBadge },
    { label: "On our message", width: "36%", cell: (r) => (r.text ? clip(r.text, 140) : "—") },
    { label: "Channel", width: "16%", cell: (r) => channelName(nameOf(r.channelId)) },
    { label: "When", width: "12%", cell: (r) => when(r.createdAt) },
  ];
  const [page, selects, posts, reactions, opened] = await Promise.all([
    listPage<MessageRow>({
      table: messageReactions, where: and(scoped, messageSearch(workspaceId, state.q)), time: messageReactions.created_at, id: messageReactions.id,
      limit: PAGE_SIZE, after: state.after, before: state.before, keyOf: (r) => ({ at: r.createdAt, id: r.id }),
      fetch: (q) => selectMessageRows().where(q.where).orderBy(...q.orderBy).limit(q.limit),
    }),
    filterSelects(workspaceId, chans),
    countPosts(workspaceId, scope),
    countMessageReactions(scoped),
    isUuid(state.open) ? selectMessageRows().where(and(eq(messageReactions.workspace_id, workspaceId), eq(messageReactions.id, state.open))).limit(1).then((r) => r[0]) : undefined,
  ]);
  const openedChannel = opened ? nameOf(opened.channelId) : undefined;
  return dataList<MessageRow>({
    path: MESSAGE_PATH,
    noun: "reactions",
    state,
    searchPlaceholder: "Search person or message…",
    tabs: viewTabs(state, MESSAGE_PATH, posts, reactions),
    selects,
    columns,
    rows: page.rows,
    rowId: (r) => r.id,
    sub: (r) => html`${r.emoji ?? REACTION_EMOJI[r.type] ?? r.type} · ${channelName(nameOf(r.channelId))} · ${timeAgo(r.createdAt)}`,
    page,
    detail: opened
      ? {
          title: opened.who ?? "Someone",
          body: html`<dl class="dl-facts">
              <dt>Reaction</dt><dd>${reactionBadge(opened)}</dd>
              <dt>Channel</dt><dd>${platformName(openedChannel?.platform)} · ${channelName(openedChannel)}</dd>
              <dt>When</dt><dd>${localTime(opened.createdAt)}</dd>
              ${opened.text ? html`<dt>On our message</dt><dd>${opened.text}</dd>` : ""}
            </dl>
            <a class="btn btn-secondary btn-sm dl-action" href="/inbox/${opened.conversationId}">Open conversation</a>`,
        }
      : undefined,
    emptyTitle: "No message reactions yet",
    emptyBody: "When someone reacts to one of your direct messages, it shows up here.",
  });
}

export function registerEngagement(r: Hono, guard: MiddlewareHandler, proLock: (title: string, body: Html, upgradeUrl: string) => Html): void {
  const page = (render: typeof renderPosts, path: string) => async (c: Context) => {
    const a = await authenticate(c.req.raw).catch(() => null);
    if (!a) return c.redirect("/login");
    const { features, upgradeUrl, products } = await getInstanceLicense();
    const title = t("title.suffix", { section: "Engagement" });
    if (!features.has("contacts_crm")) {
      return c.html(dashboardDoc(title, path, proLock("Engagement", html`Seeing who reacted to your posts is a PRO feature.`, upgradeUrl), features, products));
    }
    const chans = await db.query.channels.findMany({
      where: eq(channels.workspace_id, a.workspaceId),
      columns: { id: true, platform: true, display_name: true, username: true, brand_key: true },
    });
    return c.html(
      dashboardDoc(
        title,
        POST_PATH,
        html`<div class="page">
          <h1>Engagement</h1>
          <p class="section-intro">Who reacted to your posts and messages.</p>
          <div class="callout">${icon("info", "ico", 15)}<div>
            Facebook delivers <em>post</em> reactions. Instagram does not send <strong>post likes</strong> over its API, so
            Instagram engagement arrives as <em>message reactions</em> and as comments in your <a href="/inbox">Inbox</a>.
          </div></div>
          ${await render(a.workspaceId, c.req.url, chans)}
        </div>`,
        features,
        products,
      ),
    );
  };
  r.get(POST_PATH, guard, page(renderPosts, POST_PATH));
  r.get(MESSAGE_PATH, guard, page(renderMessages, MESSAGE_PATH));
}
