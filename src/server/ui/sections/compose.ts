import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { z } from "zod";
import { LIMITS } from "@/lib/api/limits";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { listBrands } from "@/lib/brands/service";
import { resolveBrandSlots } from "@/lib/brands/resolve";
import { composeContent } from "@/lib/content/compose";
import { renderPage } from "../layout";
import { btn } from "../components/button";
import { platformLabel } from "../components/platform";

type Html = ReturnType<typeof html>;

const composeSchema = z.object({
  brand: z.string().min(1).max(LIMITS.line),
  title: z.string().min(1).max(LIMITS.name),
  contentType: z.string().max(LIMITS.line).optional(),
  mediaUrl: z.string().min(1).max(LIMITS.url),
  coverUrl: z.string().max(LIMITS.url).optional(),
  baseDescription: z.string().max(LIMITS.text).optional(),
  baseHashtags: z.string().max(LIMITS.hashtags).optional(),
  posts: z
    .array(
      z.object({
        platform: z.string().min(1).max(LIMITS.line),
        description: z.string().max(LIMITS.text).optional(),
        hashtags: z.string().max(LIMITS.hashtags).optional(),
      }),
    )
    .min(1),
});

const CONTENT_TYPES: [string, string][] = [
  ["video", "Video"],
  ["image", "Image"],
];

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

type PlatformOpt = { platform: string; name: string; label: string };
async function brandsData(workspaceId: string): Promise<Record<string, { name: string; platforms: PlatformOpt[] }>> {
  const brands = await listBrands(workspaceId);
  const out: Record<string, { name: string; platforms: PlatformOpt[] }> = {};
  for (const b of brands) {
    const slots = await resolveBrandSlots(workspaceId, b.key);
    out[b.key] = {
      name: b.name,
      platforms: slots
        .filter((s) => s.channel)
        .map((s) => ({ platform: s.platform, name: platformLabel(s.platform), label: s.channel!.label })),
    };
  }
  return out;
}

function composeScript(): Html {
  return html`<script>
    function psCompose() {
      var data = {};
      try { data = JSON.parse(document.getElementById("ps-compose-data").textContent); } catch (e) {}
      return {
        brands: data,
        brandList: Object.keys(data).map(function (k) { return { key: k, name: data[k].name }; }),
        LIMITS: { instagram: 2200, facebook: 5000, tiktok: 2200, youtube: 5000, threads: 500, x: 280, linkedin: 3000 },
        brand: "", title: "", type: "video", mediaUrl: "", coverUrl: "", baseDescription: "", baseHashtags: "",
        sel: {},
        get availPlatforms() { return this.brand && this.brands[this.brand] ? this.brands[this.brand].platforms : []; },
        get hasBrands() { return this.brandList.length > 0; },
        onBrandChange() {
          var s = {};
          this.availPlatforms.forEach(function (p) { s[p.platform] = { on: true, override: "" }; });
          this.sel = s;
        },
        baseFull() { return [this.baseDescription, this.baseHashtags].filter(Boolean).join("\\n\\n"); },
        captionFor(p) { var o = this.sel[p] && this.sel[p].override; return o ? o : this.baseFull(); },
        limit(p) { return this.LIMITS[p] || 2200; },
        count(p) { return this.captionFor(p).length; },
        over(p) { return this.count(p) > this.limit(p); },
        selectedPlatforms() { return this.availPlatforms.filter((p) => this.sel[p.platform] && this.sel[p.platform].on); },
        isImage() { return /\\.(png|jpe?g|gif|webp|avif)(\\?|$)/i.test(this.mediaUrl); },
        previewImg() { return this.coverUrl || (this.isImage() ? this.mediaUrl : ""); },
        canSubmit() { return !!(this.brand && this.title.trim() && this.mediaUrl.trim() && this.selectedPlatforms().length); },
        buildPayload() {
          return {
            brand: this.brand, title: this.title.trim(), contentType: this.type,
            mediaUrl: this.mediaUrl.trim(), coverUrl: this.coverUrl.trim() || undefined,
            baseDescription: this.baseDescription || undefined, baseHashtags: this.baseHashtags || undefined,
            posts: this.selectedPlatforms().map((p) => ({ platform: p.platform, description: (this.sel[p.platform].override || "").trim() || undefined })),
          };
        },
        onSubmit(e) {
          if (!this.canSubmit()) { e.preventDefault(); return; }
          this.$refs.payload.value = JSON.stringify(this.buildPayload());
        },
      };
    }
  </script>`;
}

function composePage(
  data: Awaited<ReturnType<typeof brandsData>>,
  features: Awaited<ReturnType<typeof getInstanceLicense>>["features"],
  products: Awaited<ReturnType<typeof getInstanceLicense>>["products"],
  error?: string,
): Html {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const typeOpts = CONTENT_TYPES.map(([v, label]) => html`<option value="${v}">${label}</option>`);
  const brandOpts = Object.entries(data).map(([key, v]) => html`<option value="${key}">${v.name}</option>`);
  return renderPage({
    title: "Compose",
    nav: "compose",
    features,
    products,
    breadcrumb: "Create content",
    body: html`${error ? html`<div class="auth-error">${error}</div>` : ""}
      <div class="compose" x-data="psCompose()">
        <form class="compose-form" method="post" action="/compose" @submit="onSubmit($event)">
          <input type="hidden" name="payload" x-ref="payload" />

          <section class="panel">
            <div class="panel-head"><h3>Brand &amp; asset</h3></div>
            <label class="fld">
              <span>Brand</span>
              <select x-model="brand" @change="onBrandChange()" aria-label="Brand" required>
                <option value="">— select a brand —</option>
                ${brandOpts}
              </select>
            </label>
            <template x-if="!hasBrands">
              <p class="card-hint"><small>No brands yet — create one and map its channels in <a href="/brands">Brands</a> first.</small></p>
            </template>
            <label class="fld"><span>Title</span><input type="text" x-model="title" maxlength="200" placeholder="Internal title" required /></label>
            <div class="fld-row">
              <label class="fld"><span>Type</span>
                <select x-model="type" aria-label="Content type">${typeOpts}</select>
              </label>
              <label class="fld grow"><span>Media URL</span><input type="url" x-model="mediaUrl" placeholder="https://cdn…/reel.mp4" required /></label>
            </div>
            <label class="fld"><span>Cover URL <small>(optional)</small></span><input type="url" x-model="coverUrl" placeholder="https://cdn…/cover.png" /></label>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>Caption</h3></div>
            <label class="fld"><span>Base description</span><textarea x-model="baseDescription" rows="4" placeholder="Caption shared by every platform — override it per platform in the Platforms section"></textarea></label>
            <label class="fld"><span>Base hashtags</span><input type="text" x-model="baseHashtags" placeholder="#ai #automation" /></label>
          </section>

          <section class="panel" x-show="brand" x-cloak>
            <div class="panel-head"><h3>Platforms</h3><span class="panel-count" x-text="selectedPlatforms().length"></span></div>
            <p class="card-hint"><small>Toggle targets and tailor the caption per platform (empty = uses the base).</small></p>
            <div class="compose-platforms">
              <template x-for="p in availPlatforms" :key="p.platform">
                <div class="compose-plat" :class="sel[p.platform] && sel[p.platform].on ? 'on' : 'off'">
                  <label class="compose-plat-head">
                    <input type="checkbox" x-model="sel[p.platform].on" />
                    <span class="compose-plat-name" x-text="p.name"></span>
                    <span class="compose-plat-ch" x-text="'→ ' + p.label"></span>
                  </label>
                  <template x-if="sel[p.platform] && sel[p.platform].on">
                    <div class="compose-plat-body">
                      <textarea x-model="sel[p.platform].override" rows="3" :placeholder="baseFull() || 'Caption for this platform…'"></textarea>
                      <div class="compose-counter" :class="over(p.platform) ? 'over' : ''"><span x-text="count(p.platform)"></span> / <span x-text="limit(p.platform)"></span></div>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </section>

          <div class="compose-actions">
            ${btn({ label: "Create & open publish →", variant: "primary", attrs: 'type="submit" x-bind:disabled="!canSubmit()"' })}
            <small class="compose-note">Saved as a draft — you publish or schedule on the next screen.</small>
          </div>
        </form>

        <aside class="compose-preview" x-show="brand" x-cloak>
          <div class="panel-head"><h3>Preview</h3></div>
          <template x-if="selectedPlatforms().length === 0">
            <p class="card-hint"><small>Select at least one platform.</small></p>
          </template>
          <template x-for="p in selectedPlatforms()" :key="p.platform">
            <article class="preview-card">
              <header class="preview-head">
                <span class="preview-platform" x-text="p.name"></span>
                <span class="preview-channel" x-text="p.label"></span>
              </header>
              <div class="preview-media">
                <img x-show="previewImg()" :src="previewImg()" alt="" onerror="this.style.display='none'" />
                <div class="preview-media-empty" x-show="!previewImg()"><small x-text="mediaUrl ? 'video' : 'no media yet'"></small></div>
              </div>
              <p class="preview-caption" x-text="captionFor(p.platform) || 'No caption'"></p>
              <div class="preview-foot">
                <span class="compose-counter" :class="over(p.platform) ? 'over' : ''"><span x-text="count(p.platform)"></span> / <span x-text="limit(p.platform)"></span></span>
              </div>
            </article>
          </template>
        </aside>
      </div>
      <script id="ps-compose-data" type="application/json">${raw(json)}</script>
      ${composeScript()}`,
  });
}

export function registerCompose(r: Hono, guard: MiddlewareHandler): void {
  r.get("/compose", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const lic = await getInstanceLicense();
    return c.html(composePage(await brandsData(a.workspaceId), lic.features, lic.products));
  });

  r.post("/compose", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const form = await c.req.parseBody();
    const lic = await getInstanceLicense();
    let parsed: z.infer<typeof composeSchema>;
    try {
      parsed = composeSchema.parse(JSON.parse(String(form.payload ?? "{}")));
    } catch {
      return c.html(composePage(await brandsData(a.workspaceId), lic.features, lic.products, "Could not read the form — please try again."), 400);
    }
    const { contentId } = await composeContent(parsed, a.workspaceId);
    return c.redirect(`/content/${contentId}`, 303);
  });
}
