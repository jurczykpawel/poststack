import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { inArray, and, eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { posts as postsTbl, content as contentTbl } from "@/db/schema";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { listContent, getContent, getPost, patchPost, type PostRow } from "@/lib/content/service";
import { listBrands, getBrand, type BrandRow } from "@/lib/brands/service";
import { resolveChannelForBrandPlatform } from "@/lib/brands/resolve";
import { publishPosts } from "@/lib/content/publish-batch";
import { renderPage } from "../layout";
import { statusBadge, postTone } from "../components/status";
import { platformCell, platformLabel } from "../components/platform";
import { btn } from "../components/button";
import { copyBtn } from "../components/copy";
import { urlLink } from "../components/url";
import { relTime } from "../components/format";
import { emptyState } from "../components/empty-state";
import { isHtmx, toastHeader } from "../components/toast";

type Html = ReturnType<typeof html>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

// ── brand chip ────────────────────────────────────────────────────────────────
function brandChip(profile: string | null, brand: BrandRow | undefined): Html {
  if (brand) {
    const swatch = brand.accent ? html`<span class="brand-swatch" style="background:${brand.accent}"></span>` : "";
    const ico = brand.icon ? html`<span class="brand-ico">${brand.icon}</span>` : "";
    return html`<a class="brand-chip" href="/brands">${ico}${swatch}${brand.name}</a>`;
  }
  if (profile) return html`<a class="brand-chip is-muted" href="/brands" title="Not a registered brand">${profile}</a>`;
  return html`<span class="brand-chip is-muted">no brand</span>`;
}

// ── list ────────────────────────────────────────────────────────────────────
function platformStrip(posts: { platform: string; status: string }[]): Html {
  if (!posts.length) return html`<small>—</small>`;
  return html`<div class="plat-strip">
    ${posts.map((p) => html`<span class="plat-dot tone-${postTone(p.status)}" title="${p.platform}: ${p.status}">${platformLabel(p.platform)}</span>`)}
  </div>`;
}

function contentRow(
  c: { id: string; title: string; content_type: string | null; status: string; updated_at: Date },
  posts: { platform: string; status: string }[],
): Html {
  const link = `/content/${c.id}`;
  return html`<tr>
    <td data-label="Title"><a class="row-link" href="${link}">${c.title}</a></td>
    <td data-label="Type"><span class="mode-tag">${c.content_type ?? "—"}</span></td>
    <td data-label="Platforms">${platformStrip(posts)}</td>
    <td data-label="Status">${statusBadge(c.status)}</td>
    <td data-label="Updated"><small>${relTime(c.updated_at)}</small></td>
  </tr>`;
}

function filterBar(
  brands: BrandRow[],
  statuses: string[],
  active: { status?: string; profile?: string; q?: string },
): Html {
  const brandOpts = brands.map(
    (b) => html`<option value="${b.key}"${active.profile === b.key ? raw(" selected") : raw("")}>${b.name}</option>`,
  );
  // Status is open-set free text (NocoDB import), so the dropdown is built from the statuses actually
  // present in this workspace — no guessing, no typing. The active value is included even if it somehow
  // isn't in the distinct set, so a deep-linked filter never silently drops.
  const statusValues = active.status && !statuses.includes(active.status) ? [active.status, ...statuses] : statuses;
  const statusOpts = statusValues.map(
    (s) => html`<option value="${s}"${active.status === s ? raw(" selected") : raw("")}>${s}</option>`,
  );
  return html`<form class="filter-bar" method="get" action="/content" role="search">
    <input type="search" name="q" value="${active.q ?? ""}" placeholder="Search title…" aria-label="Search content" />
    <select name="profile" aria-label="Filter by brand">
      <option value="">All brands</option>
      ${brandOpts}
    </select>
    <select name="status" aria-label="Filter by status">
      <option value="">All statuses</option>
      ${statusOpts}
    </select>
    <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
    ${active.status || active.profile || active.q ? html`<a class="filter-clear" href="/content">Clear</a>` : ""}
  </form>`;
}

async function listPage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const ws = a.workspaceId;
  const url = new URL(c.req.url);
  const status = url.searchParams.get("status")?.trim() || undefined;
  const profile = url.searchParams.get("profile")?.trim() || undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;

  const [brands, { items }, lic, statusRows] = await Promise.all([
    listBrands(ws),
    listContent({ workspaceId: ws, limit: 200, status, profile, q }),
    getInstanceLicense(),
    // Distinct statuses present in this workspace → drives the status dropdown (open-set, so derived
    // from data, not a hardcoded enum).
    db.selectDistinct({ status: contentTbl.status }).from(contentTbl)
      .where(eq(contentTbl.workspace_id, ws)).orderBy(asc(contentTbl.status)),
  ]);
  const statuses = statusRows.map((r) => r.status).filter((s): s is string => !!s);
  const nameByKey = new Map(brands.map((b) => [b.key, b.name] as const));

  const ids = items.map((i) => i.id);
  const postsByContent = new Map<string, { platform: string; status: string }[]>();
  if (ids.length) {
    const rows = await db.query.posts.findMany({
      where: and(eq(postsTbl.workspace_id, ws), inArray(postsTbl.content_id, ids)),
      columns: { content_id: true, platform: true, status: true },
    });
    for (const r of rows) {
      if (!r.content_id) continue;
      (postsByContent.get(r.content_id) ?? postsByContent.set(r.content_id, []).get(r.content_id)!).push(r);
    }
  }

  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const k = it.profile?.trim() || "";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(it);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return (nameByKey.get(a) ?? a).localeCompare(nameByKey.get(b) ?? b);
  });

  const empty = items.length === 0;
  const bodyRows = orderedKeys.flatMap((k) => {
    const label = k === "" ? "No brand" : (nameByKey.get(k) ?? k);
    const list = groups.get(k)!;
    return [
      html`<tr class="row-group-head"><td colspan="5">${label} <span class="muted">(${list.length})</span></td></tr>`,
      ...list.map((it) => contentRow(it, postsByContent.get(it.id) ?? [])),
    ];
  });

  return c.html(
    renderPage({
      title: "Content",
      nav: "content",
      features: lic.features,
      products: lic.products,
      breadcrumb: `${items.length} shown`,
      body: html`${filterBar(brands, statuses, { status, profile, q })}
        <div class="table-wrap">
          <table class="data-table" aria-label="Content">
            <thead>
              <tr><th scope="col">Title</th><th scope="col">Type</th><th scope="col">Platforms</th><th scope="col">Status</th><th scope="col">Updated</th></tr>
            </thead>
            <tbody>
              ${empty ? html`<tr><td colspan="5" class="table-empty">No content matches these filters.</td></tr>` : bodyRows}
            </tbody>
          </table>
        </div>
        ${empty && !status && !profile && !q
          ? emptyState({ title: "No content yet", body: "Author content in Compose, or via the API / agents — it appears here.", action: { label: "Compose", href: "/compose" } })
          : ""}`,
    }),
  );
}

// ── post card ────────────────────────────────────────────────────────────────
const cardId = (id: string) => `post-card-${id}`;
const hxCard = (postId: string) => raw(`hx-target="#${cardId(postId)}" hx-swap="outerHTML"`);

interface PostView {
  post: PostRow;
  channelLabel?: string;
  reason?: string;
}

async function resolvePosts(ws: string, profile: string | null, posts: PostRow[]): Promise<PostView[]> {
  const brandKey = profile?.trim();
  return Promise.all(
    posts.map(async (post) => {
      if (post.status !== "planned") return { post };
      if (!brandKey) return { post, reason: "Content has no brand — set its profile" };
      const ch = await resolveChannelForBrandPlatform(ws, brandKey, post.platform);
      return ch ? { post, channelLabel: ch.label } : { post, reason: `No ${post.platform} channel mapped for ${brandKey}` };
    }),
  );
}

function copyRow(label: string, value: string | null, copyLabel: string): Html {
  if (!value) return html``;
  return html`<div class="card-field">
    <span class="card-field-k">${label}</span>
    <span class="card-field-v">${value}</span>
    ${copyBtn(value, copyLabel)}
  </div>`;
}

function publishControl(contentId: string, v: PostView): Html {
  const { post } = v;
  if (post.status !== "planned") {
    return html`<div class="card-published">
      ${statusBadge(post.status)}
      ${post.delivery_id ? html`<a class="meta-mono" href="/queue/${post.delivery_id}">view delivery →</a>` : ""}
      ${urlLink(post.published_url, "open ↗")}
    </div>`;
  }
  if (v.reason) {
    return html`<div class="card-warn">
      <small>⚠ ${v.reason}</small> <a href="/brands">Set in Brands →</a>
    </div>`;
  }
  const action = `/content/${contentId}/posts/${post.id}/publish`;
  return html`<div class="card-publish">
    <label class="pub-pick">
      <input type="checkbox" class="pub-check" name="postIds" value="${post.id}" x-model="selected" />
      <span class="pub-target">→ ${v.channelLabel}</span>
    </label>
    <button type="button" class="btn btn-primary btn-sm"
      hx-post="${action}" hx-include="#publish-panel" hx-target="#publish-panel" hx-swap="outerHTML"
      :disabled="!validFuture" x-text="rowLabel()">Publish now</button>
  </div>`;
}

function postCard(contentId: string, v: PostView): Html {
  const { post } = v;
  const editHref = `/content/${contentId}/posts/${post.id}/edit`;
  const description = post.description ?? "";
  return html`<article class="post-card" id="${cardId(post.id)}">
    <header class="post-card-head">
      ${platformCell(post.platform)} ${statusBadge(post.status)}
      <button class="btn btn-ghost btn-sm card-edit" hx-get="${editHref}" ${hxCard(post.id)} type="button">Edit</button>
    </header>
    <div class="post-card-desc">
      <p class="card-desc-text">${description || html`<small>(no description)</small>`}</p>
      ${description ? copyBtn(description, "Copy caption") : ""}
    </div>
    <div class="post-card-fields">
      ${copyRow("Hashtags", post.hashtags, "Copy")}
      ${copyRow("Cover", post.cover_url, "Copy cover")}
      ${copyRow("Media", post.video_url ?? post.media_url, "Copy media")}
    </div>
    ${publishControl(contentId, v)}
  </article>`;
}

function postCardEdit(contentId: string, post: PostRow): Html {
  const save = `/content/${contentId}/posts/${post.id}/description`;
  const cancel = `/content/${contentId}/posts/${post.id}/card`;
  return html`<article class="post-card post-card-editing" id="${cardId(post.id)}">
    <header class="post-card-head">${platformCell(post.platform)} ${statusBadge(post.status)}</header>
    <form method="post" action="${save}" hx-post="${save}" ${hxCard(post.id)}>
      <textarea name="description" class="card-edit-area" rows="5" aria-label="Description">${post.description ?? ""}</textarea>
      <div class="card-edit-actions">
        ${btn({ label: "Save", variant: "primary", size: "sm", attrs: 'type="submit"' })}
        <button class="btn btn-ghost btn-sm" type="button" hx-get="${cancel}" ${hxCard(post.id)}>Cancel</button>
      </div>
    </form>
  </article>`;
}

// ── publish panel ──────────────────────────────────────────────────────────────
function publishPanel(contentId: string, views: PostView[]): Html {
  const selectableIds = views.filter((v) => v.post.status === "planned" && v.channelLabel).map((v) => v.post.id);
  const idsLiteral = raw(`[${selectableIds.map((id) => `'${id}'`).join(",")}]`);
  const cards = views.map((v) => postCard(contentId, v));
  const canPublish = selectableIds.length > 0;
  return html`<section class="publish-panel" id="publish-panel" x-data="psPublish(${idsLiteral})">
    <div class="publish-bar">
      <div class="when-control" role="group" aria-label="When to publish">
        <div class="seg">
          <button type="button" class="seg-btn" :class="mode==='now' ? 'on' : ''" @click="mode='now'">Now</button>
          <button type="button" class="seg-btn" :class="mode==='schedule' ? 'on' : ''" @click="mode='schedule'">Schedule</button>
        </div>
        <input type="datetime-local" class="when-at" x-show="mode==='schedule'" x-model="atLocal" :min="minLocal" aria-label="Schedule time" />
      </div>
      ${canPublish
        ? html`<label class="select-all"><input type="checkbox" :checked="allSelected" @change="toggleAll($event.target.checked)" /> Select all</label>
            <button type="button" class="btn btn-primary btn-sm publish-bulk"
              hx-post="/content/${contentId}/publish-batch" hx-include="#publish-panel" hx-target="#publish-panel" hx-swap="outerHTML"
              :disabled="selected.length===0 || !validFuture" x-text="bulkLabel()">Publish now</button>`
        : html`<span class="publish-none"><small>Nothing to publish — every platform is already sent or unmapped.</small></span>`}
    </div>
    <input type="hidden" name="mode" :value="mode" />
    <input type="hidden" name="at" :value="atIso" />
    <div class="card-grid">${cards}</div>
  </section>`;
}

function publishPanelScript(): Html {
  return html`<script>
    function psPublish(ids) {
      return {
        all: ids || [],
        selected: [...(ids || [])],
        mode: "now",
        atLocal: "",
        get minLocal() {
          const d = new Date(Date.now() + 60000);
          const p = (n) => String(n).padStart(2, "0");
          return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
        },
        get allSelected() { return this.all.length > 0 && this.selected.length === this.all.length; },
        get validFuture() { return this.mode === "now" || (!!this.atLocal && new Date(this.atLocal).getTime() > Date.now()); },
        get atIso() { return this.mode === "schedule" && this.atLocal ? new Date(this.atLocal).toISOString() : ""; },
        toggleAll(v) { this.selected = v ? [...this.all] : []; },
        fmtAt() { try { return new Date(this.atLocal).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return ""; } },
        bulkLabel() {
          const n = this.selected.length;
          const base = this.mode === "now" ? "Publish now" : (this.atLocal ? "Schedule for " + this.fmtAt() : "Schedule");
          return n ? base + " · " + n : base;
        },
        rowLabel() { return this.mode === "now" ? "Publish now" : "Schedule"; },
      };
    }
  </script>`;
}

// ── detail ────────────────────────────────────────────────────────────────────
async function detailPage(c: Context): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const ws = a.workspaceId;
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return c.text("not found", 404);
  const content = await getContent(id, ws);
  if (!content) return c.text("not found", 404);

  const [brand, views, lic] = await Promise.all([
    content.profile ? getBrand(ws, content.profile.trim()) : Promise.resolve(undefined),
    resolvePosts(ws, content.profile, content.posts),
    getInstanceLicense(),
  ]);

  return c.html(
    renderPage({
      title: content.title,
      nav: "content",
      features: lic.features,
      products: lic.products,
      breadcrumb: `Content / ${content.title}`,
      primaryAction: btn({ label: "All content", href: "/content", variant: "ghost" }),
      body: html`<section class="panel">
          <div class="panel-head"><h3>Content</h3>${brandChip(content.profile, brand)} ${statusBadge(content.status)}</div>
          <dl class="meta-list">
            <div class="meta-row"><dt>Type</dt><dd><span class="mode-tag">${content.content_type ?? "—"}</span></dd></div>
            ${content.base_hashtags ? html`<div class="meta-row"><dt>Base hashtags</dt><dd>${content.base_hashtags} ${copyBtn(content.base_hashtags, "Copy")}</dd></div>` : ""}
          </dl>
          ${content.script ? html`<details class="card-script"><summary>Script</summary><pre class="payload">${content.script}</pre></details>` : ""}
        </section>
        <div class="panel-head"><h3>Publish</h3><span class="panel-count">${content.posts.length}</span></div>
        ${content.posts.length
          ? html`${publishPanel(id, views)}${publishPanelScript()}`
          : emptyState({ title: "No posts", body: "Per-platform posts for this content appear here." })}`,
    }),
  );
}

// ── fragment + action routes ─────────────────────────────────────────────────
async function renderPublishPanel(ws: string, contentId: string): Promise<Html | null> {
  const content = await getContent(contentId, ws);
  if (!content) return null;
  const views = await resolvePosts(ws, content.profile, content.posts);
  return publishPanel(contentId, views);
}

async function cardFragment(ws: string, contentId: string, postId: string, edit: boolean): Promise<Html | null> {
  const post = await getPost(postId, ws);
  if (!post) return null;
  if (edit) return postCardEdit(contentId, post);
  const content = post.content_id ? await getContent(post.content_id, ws) : null;
  const [view] = await resolvePosts(ws, content?.profile ?? null, [post]);
  return postCard(contentId, view!);
}

function whenFromForm(form: Record<string, unknown>): "now" | string {
  const mode = String(form.mode ?? "now");
  const at = String(form.at ?? "").trim();
  return mode === "schedule" && at ? at : "now";
}

export function registerContent(r: Hono, guard: MiddlewareHandler): void {
  r.get("/content", guard, listPage);
  r.get("/content/:id", guard, detailPage);

  r.get("/content/:id/posts/:postId/card", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const frag = await cardFragment(a.workspaceId, c.req.param("id"), c.req.param("postId"), false);
    return frag ? c.html(frag) : c.text("not found", 404);
  });
  r.get("/content/:id/posts/:postId/edit", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const frag = await cardFragment(a.workspaceId, c.req.param("id"), c.req.param("postId"), true);
    return frag ? c.html(frag) : c.text("not found", 404);
  });

  r.post("/content/:id/posts/:postId/description", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { id, postId } = c.req.param();
    const form = await c.req.parseBody();
    await patchPost(postId, a.workspaceId, { description: String(form.description ?? "") });
    const frag = await cardFragment(a.workspaceId, id, postId, false);
    if (!frag) return c.text("not found", 404);
    if (isHtmx(c)) {
      toastHeader(c, "ok", "Description saved");
      return c.html(frag);
    }
    return c.redirect(`/content/${id}`, 303);
  });

  r.post("/content/:id/posts/:postId/publish", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const { id, postId } = c.req.param();
    const form = await c.req.parseBody();
    const when = whenFromForm(form);
    const [res] = await publishPosts([postId], when, a.workspaceId);
    const panel = await renderPublishPanel(a.workspaceId, id);
    if (!panel) return c.text("not found", 404);
    if (isHtmx(c)) {
      if (res && !res.ok) toastHeader(c, "warn", res.reason);
      else toastHeader(c, "ok", when === "now" ? "Publishing now" : "Scheduled");
      return c.html(panel);
    }
    return c.redirect(`/content/${id}`, 303);
  });

  r.post("/content/:id/publish-batch", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const id = c.req.param("id");
    const form = await c.req.parseBody({ all: true });
    const rawIds = form.postIds;
    const postIds = Array.isArray(rawIds) ? rawIds.map(String) : rawIds ? [String(rawIds)] : [];
    const when = whenFromForm(form as Record<string, unknown>);
    const results = await publishPosts(postIds, when, a.workspaceId);
    const ok = results.filter((res) => res.ok).length;
    const failed = results.length - ok;
    const panel = await renderPublishPanel(a.workspaceId, id);
    if (!panel) return c.text("not found", 404);
    if (isHtmx(c)) {
      const verb = when === "now" ? "Published" : "Scheduled";
      toastHeader(c, failed ? "warn" : "ok", `${verb} ${ok}${failed ? ` (${failed} skipped)` : ""}`);
      return c.html(panel);
    }
    return c.redirect(`/content/${id}`, 303);
  });
}
