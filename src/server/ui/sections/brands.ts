import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands as brandsTbl, channels as channelsTbl } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense, LimitExceededError, ProRequiredError } from "@/lib/license/gate";
import { createBrand, listBrands, getBrand, updateBrand, deleteBrand, type BrandRow } from "@/lib/brands/service";
import { resolveBrandSlots, EDITORIAL_PLATFORMS } from "@/lib/brands/resolve";
import { lockedBrandKeys } from "@/lib/brands/access";
import { channelMatchesPlatform } from "@/lib/channels/platform-match";
import { env } from "@/lib/env";
import { createWithinLimit } from "@/lib/license/limit-guard";
import { listChannels } from "@/lib/channels/service";
import { renderPage } from "../layout";
import { pill } from "../components/status";
import { platformLabel } from "../components/platform";
import { btn } from "../components/button";
import { isHtmx, toastHeader } from "../components/toast";

type Html = ReturnType<typeof html>;

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

function domSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Channels (id+label) eligible to publish a post on `platform`, scoped to the workspace. The
 *  editorial platform `x` maps onto the `twitter` channel platform (the enum value); everything else
 *  is the channel platform directly. channelMatchesPlatform re-applies the same alias as a guard. */
async function channelsForPlatform(workspaceId: string, platform: string): Promise<{ id: string; label: string }[]> {
  const p = platform.trim().toLowerCase();
  const channelPlatform = p === "x" ? "twitter" : p;
  const { items } = await listChannels({ workspaceId, limit: 100, platform: channelPlatform });
  return items
    .filter((c) => channelMatchesPlatform(platform, { platform: c.platform, metadata: c.metadata }))
    .map((c) => ({ id: c.id, label: c.display_name ?? c.provider_account_id }));
}

// ── form fields ─────────────────────────────────────────────────────────────────
function accentField(value = ""): Html {
  return html`<div class="brand-fld" x-data>
    <span>Accent colour <small>(optional)</small></span>
    <span class="accent-field">
      <input type="color" aria-label="Accent colour picker" value="${value || "#7aa2f7"}"
        @input="$refs.hex.value = $event.target.value" />
      <input name="accent" x-ref="hex" value="${value}" placeholder="#7aa2f7" aria-label="Accent colour hex" />
    </span>
  </div>`;
}

const ICON_SUGGESTIONS = ["📮", "🚀", "🎬", "📣", "📈", "🗓️", "🟦", "🛰️", "💬", "✏️", "🎯", "🔥"];

function iconField(value = ""): Html {
  const picks = `[${ICON_SUGGESTIONS.map((e) => `'${e}'`).join(",")}]`;
  return html`<div class="brand-fld" x-data="{ picks: ${raw(picks)} }">
    <span>Brand icon <small>(emoji, shown as the brand mark — optional)</small></span>
    <input name="icon" x-ref="icon" value="${value}" placeholder="e.g. 📮" aria-label="Brand icon (emoji)" maxlength="8" />
    <span class="emoji-row" role="group" aria-label="Emoji suggestions">
      <template x-for="e in picks" :key="e">
        <button type="button" class="emoji-pick" @click="$refs.icon.value = e" x-text="e"></button>
      </template>
    </span>
  </div>`;
}

async function platformCandidates(workspaceId: string): Promise<Record<string, { id: string; label: string }[]>> {
  const out: Record<string, { id: string; label: string }[]> = {};
  await Promise.all(
    EDITORIAL_PLATFORMS.map(async (p) => {
      out[p] = await channelsForPlatform(workspaceId, p);
    }),
  );
  return out;
}

function slotRow(
  brandKey: string,
  platform: string,
  candidates: { id: string; label: string }[],
  selectedId: string | null,
  ambiguous: boolean,
): Html {
  const options = candidates.map(
    (ch) => html`<option value="${ch.id}"${selectedId === ch.id ? raw(" selected") : raw("")}>${ch.label}</option>`,
  );
  const warn = ambiguous ? html` ${pill("ambiguous — pick one", "warn")}` : selectedId ? html` ${pill("set", "ok")}` : "";
  const noChannels = candidates.length === 0;
  const slotId = `slot-${domSafe(brandKey)}-${domSafe(platform)}`;
  return html`<div class="brand-slot" id="${slotId}">
    <span class="brand-slot-platform">${platformLabel(platform)}</span>
    <select name="channelId" aria-label="${platformLabel(platform)} channel for ${brandKey}"
      hx-put="/brands/${brandKey}/slot/${platform}" hx-target="#${slotId}" hx-swap="outerHTML"
      ${noChannels ? raw("disabled") : raw("")}>
      <option value="">${noChannels ? "— no channels connected —" : "— not set —"}</option>
      ${options}
    </select>
    ${warn}
  </div>`;
}

async function brandSlots(workspaceId: string, brand: BrandRow, candidates: Record<string, { id: string; label: string }[]>): Promise<Html> {
  const slots = await resolveBrandSlots(workspaceId, brand.key);
  const rows = slots.map((s) => slotRow(brand.key, s.platform, candidates[s.platform] ?? [], s.channel?.id ?? null, s.ambiguous));
  return html`<div class="brand-slots">${rows}</div>`;
}

function brandCard(brand: BrandRow, slots: Html, locked = false): Html {
  const swatch = brand.accent ? html`<span class="brand-swatch" style="background:${brand.accent}"></span>` : "";
  const ico = brand.icon ? html`<span class="brand-ico">${brand.icon}</span>` : "";
  const cardId = `brand-${domSafe(brand.key)}`;
  // BRANDLIMIT1: brands beyond the free tier's limit stay visible but are flagged locked (PRO upsell)
  // and won't publish — the runtime authority is resolveChannelForBrandPlatform.
  const lockBadge = locked
    ? html`<a class="badge badge-locked" href="${env.LICENSE_UPGRADE_URL}" target="_blank" rel="noopener"
        title="Beyond your plan's brand limit — won't publish. Upgrade to activate.">🔒 PRO</a>`
    : "";
  return html`<section class="panel brand-card${locked ? " brand-locked" : ""}" id="${cardId}">
    <div class="panel-head brand-head">
      <div class="brand-title">${ico}${swatch}<h3>${brand.name}</h3><code class="brand-key">${brand.key}</code>${lockBadge}</div>
      <form method="post" action="/brands/${brand.key}/delete" hx-post="/brands/${brand.key}/delete"
        hx-target="#${cardId}" hx-swap="outerHTML"
        hx-confirm="Delete brand '${brand.name}'? Its channels become unassigned (not deleted).">
        ${btn({ label: "Delete", variant: "danger" })}
      </form>
    </div>
    <details class="brand-edit">
      <summary>Rename / recolor</summary>
      <form class="brand-edit-form" method="post" action="/brands/${brand.key}/edit"
        hx-post="/brands/${brand.key}/edit" hx-target="#${cardId}" hx-swap="outerHTML">
        <input name="name" value="${brand.name}" aria-label="Brand name" required />
        ${accentField(brand.accent ?? "")}
        ${iconField(brand.icon ?? "")}
        ${btn({ label: "Save", variant: "secondary" })}
      </form>
    </details>
    ${slots}
  </section>`;
}

async function renderBrandCard(workspaceId: string, brand: BrandRow): Promise<Html> {
  const [candidates, locked] = await Promise.all([platformCandidates(workspaceId), lockedBrandKeys(workspaceId)]);
  return brandCard(brand, await brandSlots(workspaceId, brand, candidates), locked.has(brand.key));
}

async function brandsPage(c: Context, notice?: string, status = 200): Promise<Response> {
  const a = await auth(c);
  if (!a) return c.redirect("/login");
  const ws = a.workspaceId;
  const [brands, candidates, lic, locked] = await Promise.all([
    listBrands(ws),
    platformCandidates(ws),
    getInstanceLicense(),
    lockedBrandKeys(ws),
  ]);
  const cards = await Promise.all(brands.map(async (b) => brandCard(b, await brandSlots(ws, b, candidates), locked.has(b.key))));
  const empty = brands.length === 0;

  return c.html(
    renderPage({
      title: "Brands",
      nav: "brands",
      features: lic.features,
      products: lic.products,
      breadcrumb: `${brands.length} brand${brands.length === 1 ? "" : "s"}`,
      body: html`${notice ? html`<div class="notice notice-err" role="alert">${notice}</div>` : ""}
        <p class="section-intro">
          A brand groups the channels you publish to. Map one channel per platform here, then publishing
          a content item resolves the right channel automatically.
        </p>
        <section class="panel">
          <div class="panel-head"><h3>New brand</h3></div>
          <form class="brand-new-form" method="post" action="/brands">
            <input name="key" placeholder="key (e.g. techskills.academy)" required />
            <input name="name" placeholder="Display name" required />
            ${accentField()}
            ${iconField()}
            <button class="btn btn-primary btn-sm" type="submit">Create brand</button>
          </form>
        </section>
        ${empty
          ? html`<div class="empty-state"><p>No brands yet. Create one above, then assign its channels.</p></div>`
          : html`<div class="brand-grid">${cards}</div>`}`,
    }),
    status as 200,
  );
}

/** Designate (or clear) the channel for a brand+platform — keeps exactly one channel per slot. */
async function assignSlot(workspaceId: string, brandKey: string, platform: string, channelId: string | null): Promise<void> {
  const brand = await getBrand(workspaceId, brandKey);
  if (!brand) throw new ApiError("not_found", "Brand not found", 404);
  if (!(EDITORIAL_PLATFORMS as readonly string[]).includes(platform)) {
    throw new ApiError("invalid_request", `Unknown platform '${platform}'`, 400);
  }
  await db.transaction(async (tx) => {
    const owned = await tx.query.channels.findMany({
      where: and(
        eq(channelsTbl.workspace_id, workspaceId),
        eq(channelsTbl.brand_key, brandKey),
        ne(channelsTbl.status, "disabled"),
        isNull(channelsTbl.deleted_at),
      ),
    });
    for (const ch of owned) {
      if (channelMatchesPlatform(platform, ch) && ch.id !== channelId) {
        await tx.update(channelsTbl).set({ brand_key: null, updated_at: new Date() })
          .where(and(eq(channelsTbl.id, ch.id), eq(channelsTbl.workspace_id, workspaceId)));
      }
    }
    if (channelId) {
      const picked = await tx.query.channels.findFirst({
        where: and(eq(channelsTbl.id, channelId), eq(channelsTbl.workspace_id, workspaceId), isNull(channelsTbl.deleted_at)),
      });
      if (!picked) throw new ApiError("not_found", "Channel not found", 404);
      if (!channelMatchesPlatform(platform, picked)) {
        throw new ApiError("invalid_request", "Channel does not match this platform", 400);
      }
      await tx.update(channelsTbl).set({ brand_key: brandKey, updated_at: new Date() })
        .where(and(eq(channelsTbl.id, channelId), eq(channelsTbl.workspace_id, workspaceId)));
    }
  });
}

export function registerBrands(r: Hono, guard: MiddlewareHandler): void {
  r.get("/brands", guard, (c) => brandsPage(c));

  r.post("/brands", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const ws = a.workspaceId;
    const form = await c.req.parseBody();
    const key = String(form.key ?? "");
    try {
      // Open-core: free = 1 brand; multiple brands is Pro. Atomic (advisory lock); workspace-scoped
      // count + an existing-key exemption (→ 409 via createBrand).
      await createWithinLimit("brands", {
        exempt: async (tx) => !!(await tx.query.brands.findFirst({ where: and(eq(brandsTbl.workspace_id, ws), eq(brandsTbl.key, key)) })),
        count: async (tx) => (await tx.query.brands.findMany({ where: eq(brandsTbl.workspace_id, ws), columns: { key: true } })).length,
        create: (tx) =>
          createBrand(
            { key, name: String(form.name ?? ""), accent: form.accent ? String(form.accent) : null, icon: form.icon ? String(form.icon) : null },
            ws,
            tx,
          ),
      });
    } catch (err) {
      // Limit hit (free already has its 1 brand) or area not entitled → re-render the page with a
      // friendly notice, NOT a 500/raw text. A plain full-page form POST, so we return the HTML page.
      if (err instanceof LimitExceededError || err instanceof ProRequiredError) {
        return brandsPage(c, err.message, 402);
      }
      if (err instanceof ApiError) return brandsPage(c, err.message, err.status);
      throw err;
    }
    return c.redirect("/brands", 303);
  });

  r.post("/brands/:key/edit", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const ws = a.workspaceId;
    const key = c.req.param("key");
    const form = await c.req.parseBody();
    try {
      await updateBrand(ws, key, {
        name: String(form.name ?? ""),
        accent: form.accent ? String(form.accent) : null,
        icon: form.icon ? String(form.icon) : null,
      });
    } catch (err) {
      if (err instanceof ApiError) return c.text(err.message, err.status as 400);
      throw err;
    }
    if (!isHtmx(c)) return c.redirect("/brands", 303);
    const brand = await getBrand(ws, key);
    toastHeader(c, "ok", "Brand saved");
    return c.html(await renderBrandCard(ws, brand!));
  });

  r.post("/brands/:key/delete", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const ws = a.workspaceId;
    const key = c.req.param("key");
    try {
      await deleteBrand(ws, key);
    } catch (err) {
      if (err instanceof ApiError) return c.text(err.message, err.status as 400);
      throw err;
    }
    if (!isHtmx(c)) return c.redirect("/brands", 303);
    toastHeader(c, "ok", "Brand deleted");
    c.header("HX-Redirect", "/brands");
    return c.body(null, 200);
  });

  r.put("/brands/:key/slot/:platform", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const ws = a.workspaceId;
    const key = c.req.param("key");
    const platform = c.req.param("platform");
    const form = await c.req.parseBody();
    const channelId = String(form.channelId ?? "").trim() || null;
    try {
      await assignSlot(ws, key, platform, channelId);
    } catch (err) {
      if (err instanceof ApiError) return c.text(err.message, err.status as 400);
      throw err;
    }
    const slots = await resolveBrandSlots(ws, key);
    const slot = slots.find((s) => s.platform === platform)!;
    const candidates = await channelsForPlatform(ws, platform);
    if (isHtmx(c)) toastHeader(c, "ok", `${platformLabel(platform)} channel updated`);
    return c.html(slotRow(key, platform, candidates, slot.channel?.id ?? null, slot.ambiguous));
  });
}
