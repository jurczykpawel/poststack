import type { Context, Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { z } from "zod";
import { LIMITS } from "@/lib/api/limits";
import { authenticate, type AuthContext } from "@/lib/auth";
import { getInstanceLicense } from "@/lib/license/gate";
import { listBrands } from "@/lib/brands/service";
import { resolveBrandSlots } from "@/lib/brands/resolve";
import { lockedBrandKeys } from "@/lib/brands/access";
import { composeContent } from "@/lib/content/compose";
import { publishPosts } from "@/lib/content/publish-batch";
import { autoReplyInput } from "@/lib/content/schemas";
import { db } from "@/lib/db";
import { sequences as sequencesTbl } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { renderPage } from "../layout";
import { platformLabel, platformColor, platformGlyphString } from "../components/platform";
import { icon } from "../components/icons";

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
        firstComment: z.string().max(LIMITS.text).optional(),
        autoStory: z.boolean().optional(),
        autoReply: autoReplyInput.optional(),
      }),
    )
    .min(1),
  publish: z
    .object({ mode: z.enum(["draft", "now", "schedule"]).default("draft"), at: z.string().max(40).optional() })
    .optional(),
});

const CONTENT_TYPES: [string, string][] = [
  ["video", "Video"],
  ["image", "Image"],
];

async function auth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

function loadActiveSequences(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  return db.query.sequences.findMany({
    where: and(eq(sequencesTbl.workspace_id, workspaceId), eq(sequencesTbl.status, "active")),
    orderBy: desc(sequencesTbl.created_at),
    columns: { id: true, name: true },
  });
}

type PlatformOpt = { platform: string; name: string; label: string; color: string; glyph: string };
async function brandsData(workspaceId: string): Promise<Record<string, { name: string; platforms: PlatformOpt[] }>> {
  const brands = await listBrands(workspaceId);
  const locked = await lockedBrandKeys(workspaceId);
  const out: Record<string, { name: string; platforms: PlatformOpt[] }> = {};
  for (const b of brands) {
    if (locked.has(b.key)) continue;
    const slots = await resolveBrandSlots(workspaceId, b.key);
    out[b.key] = {
      name: b.name,
      platforms: slots
        .filter((s) => s.channel)
        .map((s) => ({
          platform: s.platform,
          name: platformLabel(s.platform),
          label: s.channel!.label,
          color: platformColor(s.platform),
          glyph: platformGlyphString(s.platform, 16),
        })),
    };
  }
  return out;
}

function composeScript(): Html {
  return html`<script>
    function psCompose() {
      var data = {};
      try { data = JSON.parse(document.getElementById("ps-compose-data").textContent); } catch (e) {}
      var seqCfg = { canSequence: false, sequences: [], canFirstComment: false, canAutoStory: false };
      try { seqCfg = JSON.parse(document.getElementById("ps-compose-seq").textContent); } catch (e) {}
      return {
        brands: data,
        brandList: Object.keys(data).map(function (k) { return { key: k, name: data[k].name }; }),
        canSequence: seqCfg.canSequence,
        sequences: seqCfg.sequences,
        licFirstComment: seqCfg.canFirstComment,
        licAutoStory: seqCfg.canAutoStory,
        hasSequences() { return this.canSequence && this.sequences.length > 0; },
        LIMITS: { instagram: 2200, facebook: 5000, tiktok: 2200, youtube: 5000, threads: 500, x: 280, linkedin: 3000 },
        brand: "", title: "", type: "video", mediaUrl: "", coverUrl: "", baseDescription: "", baseHashtags: "",
        sel: {}, publishMode: "draft", scheduleAt: "", capTab: "base", pvTab: "",
        minAt() { return new Date(Date.now() + 60000).toISOString().slice(0, 16); },
        submitLabel() { return this.publishMode === "now" ? ("Publish to " + this.selectedPlatforms().length + " →") : this.publishMode === "schedule" ? "Schedule →" : "Create & open →"; },
        get availPlatforms() { return this.brand && this.brands[this.brand] ? this.brands[this.brand].platforms : []; },
        get hasBrands() { return this.brandList.length > 0; },
        STORY: { facebook: true, instagram: true },
        AUTOREPLY: { facebook: true, instagram: true },
        COMMENT: { facebook: true, instagram: true, youtube: true },
        canStory(p) { return !!this.STORY[p]; },
        canAutoReply(p) { return !!this.AUTOREPLY[p]; },
        canComment(p) { return !!this.COMMENT[p]; },
        hasAutomation(p) { return this.canComment(p) || this.canStory(p) || this.canAutoReply(p); },
        autoTargets() { return this.selectedPlatforms().filter((p) => this.hasAutomation(p.platform)); },
        onBrandChange() {
          var s = {};
          this.availPlatforms.forEach(function (p) {
            s[p.platform] = { on: true, override: "", firstComment: "", autoStory: false, arEnabled: false, arKeyword: "", arDmText: "", arResponse: "dm", arSequenceId: "" };
          });
          this.sel = s; this.capTab = "base";
          var first = this.selectedPlatforms()[0];
          this.pvTab = first ? first.platform : "";
        },
        toggleTarget(p) {
          if (!this.sel[p]) return;
          this.sel[p].on = !this.sel[p].on;
          if (this.capTab === p && !this.sel[p].on) this.capTab = "base";
          var sp = this.selectedPlatforms();
          if (!sp.find((x) => x.platform === this.pvTab)) this.pvTab = sp[0] ? sp[0].platform : "";
        },
        isOn(p) { return !!(this.sel[p] && this.sel[p].on); },
        baseFull() { return [this.baseDescription, this.baseHashtags].filter(Boolean).join("\\n\\n"); },
        captionFor(p) { var o = this.sel[p] && this.sel[p].override; return o ? o : this.baseFull(); },
        limit(p) { return this.LIMITS[p] || 2200; },
        count(p) { return this.captionFor(p).length; },
        over(p) { return this.count(p) > this.limit(p); },
        capCount() {
          var isBase = this.capTab === "base";
          var t = isBase ? this.baseFull() : ((this.sel[this.capTab] && this.sel[this.capTab].override) || this.baseFull());
          var lim = isBase ? 2200 : this.limit(this.capTab);
          return { n: t.length, lim: lim, over: t.length > lim };
        },
        selectedPlatforms() { return this.availPlatforms.filter((p) => this.sel[p.platform] && this.sel[p.platform].on); },
        isImage() { return /\\.(png|jpe?g|gif|webp|avif)(\\?|$)/i.test(this.mediaUrl); },
        previewImg() { return this.coverUrl || (this.isImage() ? this.mediaUrl : ""); },
        pvPlatform() { var sp = this.selectedPlatforms(); return sp.find((p) => p.platform === this.pvTab) || sp[0]; },
        pvKey() { var pp = this.pvPlatform(); return pp ? pp.platform : ""; },
        hasOverride(p) { return !!(this.sel[p] && (this.sel[p].override || "").length); },
        canSubmit() { return !!(this.brand && this.title.trim() && this.mediaUrl.trim() && this.selectedPlatforms().length && (this.publishMode !== "schedule" || this.scheduleAt)); },
        buildPayload() {
          return {
            brand: this.brand, title: this.title.trim(), contentType: this.type,
            mediaUrl: this.mediaUrl.trim(), coverUrl: this.coverUrl.trim() || undefined,
            baseDescription: this.baseDescription || undefined, baseHashtags: this.baseHashtags || undefined,
            posts: this.selectedPlatforms().map((p) => {
              var s = this.sel[p.platform];
              var post = { platform: p.platform, description: (s.override || "").trim() || undefined };
              var fc = (s.firstComment || "").trim();
              if (this.canComment(p.platform) && this.licFirstComment && fc) post.firstComment = fc;
              if (this.canStory(p.platform) && this.licAutoStory && s.autoStory) post.autoStory = true;
              if (this.canAutoReply(p.platform) && s.arEnabled && (s.arKeyword || "").trim()) {
                var kw = [{ value: s.arKeyword.trim(), matchType: "contains" }];
                if (s.arResponse === "sequence" && this.hasSequences() && s.arSequenceId) {
                  post.autoReply = { keywords: kw, responseType: "sequence", sequenceId: s.arSequenceId };
                } else if ((s.arDmText || "").trim()) {
                  post.autoReply = { keywords: kw, responseType: "text", dmText: s.arDmText.trim(), replyMode: "dm" };
                }
              }
              return post;
            }),
            publish: { mode: this.publishMode, at: this.publishMode === "schedule" ? new Date(this.scheduleAt).toISOString() : undefined },
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
  sequences: Array<{ id: string; name: string }> = [],
  error?: string,
): Html {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const seqJson = JSON.stringify({
    canSequence: features.has("sequences"),
    sequences,
    canFirstComment: features.has("first_comment"),
    canAutoStory: features.has("auto_story"),
  }).replace(/</g, "\\u003c");
  const typeOpts = CONTENT_TYPES.map(([v, label]) => html`<option value="${v}">${label}</option>`);
  const brandOpts = Object.entries(data).map(([key, v]) => html`<option value="${key}">${v.name}</option>`);
  const lockChip = (label: string) => html`<p class="card-hint"><span class="lock-chip">${icon("lock", "ico", 11)}PRO</span> ${label}</p>`;

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
            <div class="panel-head"><h3>Brand &amp; channels</h3><span class="panel-count" x-show="brand" x-text="selectedPlatforms().length + ' selected'"></span></div>
            <div class="compose-body">
              <label class="fld" style="max-width:320px">
                <span>Brand</span>
                <select x-model="brand" @change="onBrandChange()" aria-label="Brand" required>
                  <option value="">— select a brand —</option>
                  ${brandOpts}
                </select>
              </label>
              <template x-if="!hasBrands">
                <p class="card-hint"><small>No brands yet — create one and map its channels in <a href="/brands">Brands</a> first.</small></p>
              </template>
              <div class="targets" x-show="brand" x-cloak>
                <template x-for="p in availPlatforms" :key="p.platform">
                  <div class="target" :class="isOn(p.platform) ? 'on' : ''" @click="toggleTarget(p.platform)" role="button" tabindex="0" @keydown.enter.prevent="toggleTarget(p.platform)" @keydown.space.prevent="toggleTarget(p.platform)">
                    <span class="t-pic" :style="'background:'+p.color" x-html="p.glyph"></span>
                    <span class="t-meta"><span class="t-nm" x-text="p.name"></span><span class="t-hd" x-text="p.label"></span></span>
                    <span class="t-tick">${icon("check", "ico", 12)}</span>
                  </div>
                </template>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>Media</h3></div>
            <div class="compose-body">
              <div class="media-row">
                <div class="media-thumb">
                  <template x-if="previewImg()"><img :src="previewImg()" alt="" onerror="this.style.display='none'" /></template>
                  <template x-if="!previewImg()">${icon("image", "ico", 22)}</template>
                </div>
                <div class="media-fields">
                  <div class="fld-row">
                    <label class="fld"><span>Type</span><select x-model="type" aria-label="Content type">${typeOpts}</select></label>
                    <label class="fld grow"><span>Media URL</span><input type="url" x-model="mediaUrl" placeholder="https://cdn…/reel.mp4" required /></label>
                  </div>
                  <label class="fld"><span>Cover URL <small>(optional)</small></span><input type="url" x-model="coverUrl" placeholder="https://cdn…/cover.png" /></label>
                </div>
              </div>
            </div>
          </section>

          <section class="panel" x-show="brand" x-cloak>
            <div class="panel-head"><h3>Title &amp; caption</h3></div>
            <div class="compose-body">
              <label class="fld"><span>Title <small>(internal)</small></span><input type="text" x-model="title" maxlength="200" placeholder="Internal title" required /></label>
              <div class="cap-tabs">
                <button type="button" class="cap-tab" :class="capTab==='base' ? 'on' : ''" @click="capTab='base'">Base</button>
                <template x-for="p in selectedPlatforms()" :key="'cap-'+p.platform">
                  <button type="button" class="cap-tab" :class="capTab===p.platform ? 'on' : ''" @click="capTab=p.platform">
                    <span class="cap-glyph" :style="'color:'+p.color" x-html="p.glyph"></span><span x-text="p.name"></span>
                    <span class="cap-ov" x-show="hasOverride(p.platform)"></span>
                  </button>
                </template>
              </div>
              <div class="cap-edit">
                <textarea x-show="capTab==='base'" x-model="baseDescription" rows="4" placeholder="Caption shared by every channel — override per platform with the tabs above"></textarea>
                <template x-for="p in selectedPlatforms()" :key="'ta-'+p.platform">
                  <textarea x-show="capTab===p.platform" x-model="sel[p.platform].override" rows="4" :placeholder="baseFull() || ('Caption for '+p.name+'…')"></textarea>
                </template>
                <div class="cap-foot"><span class="compose-counter" :class="capCount().over ? 'over' : ''"><span x-text="capCount().n"></span> / <span x-text="capCount().lim"></span></span></div>
              </div>
              <label class="fld"><span>Base hashtags</span><input type="text" x-model="baseHashtags" placeholder="#ai #automation" /></label>
            </div>
          </section>

          <section class="panel" x-show="brand && selectedPlatforms().length" x-cloak>
            <div class="panel-head"><h3>Automations</h3><span class="panel-sub">fire on publish</span></div>
            <div class="compose-body">
              <template x-for="p in autoTargets()" :key="'auto-'+p.platform">
                <details class="auto">
                  <summary>${icon("chevron", "auto-chev", 14)}<span class="auto-glyph" :style="'color:'+p.color" x-html="p.glyph"></span><span class="auto-t" x-text="p.name"></span></summary>
                  <div class="auto-body">
                    <template x-if="canComment(p.platform) && licFirstComment">
                      <label class="fld"><span>First comment <small>(auto-posted under the post)</small></span><textarea x-model="sel[p.platform].firstComment" rows="2" placeholder="e.g. 👇 Comment WORD and I'll DM you the link"></textarea></label>
                    </template>
                    <template x-if="canComment(p.platform) && !licFirstComment">${lockChip("First comment")}</template>
                    <template x-if="canStory(p.platform) && licAutoStory">
                      <label class="compose-toggle"><input type="checkbox" x-model="sel[p.platform].autoStory" /><span>Auto-Story — reshare this post to your Story on publish</span></label>
                    </template>
                    <template x-if="canStory(p.platform) && !licAutoStory">${lockChip("Auto-Story")}</template>
                    <template x-if="canAutoReply(p.platform)">
                      <div class="compose-autoreply">
                        <label class="compose-toggle"><input type="checkbox" x-model="sel[p.platform].arEnabled" /><span>Comment → DM — DM people who comment a keyword</span></label>
                        <template x-if="sel[p.platform].arEnabled">
                          <div class="auto-ar">
                            <label class="fld"><span>Keyword</span><input type="text" x-model="sel[p.platform].arKeyword" maxlength="100" placeholder="LINK" /></label>
                            <template x-if="hasSequences()">
                              <label class="fld"><span>Then</span><select x-model="sel[p.platform].arResponse"><option value="dm">Send a DM</option><option value="sequence">Enroll in a sequence</option></select></label>
                            </template>
                            <template x-if="sel[p.platform].arResponse !== 'sequence' || !hasSequences()">
                              <label class="fld grow"><span>DM to send</span><input type="text" x-model="sel[p.platform].arDmText" maxlength="2000" placeholder="Here's the link you asked for…" /></label>
                            </template>
                            <template x-if="sel[p.platform].arResponse === 'sequence' && hasSequences()">
                              <label class="fld grow"><span>Sequence to enroll into</span>
                                <select x-model="sel[p.platform].arSequenceId">
                                  <option value="">— pick a sequence —</option>
                                  <template x-for="seq in sequences" :key="seq.id"><option :value="seq.id" x-text="seq.name"></option></template>
                                </select>
                              </label>
                            </template>
                          </div>
                        </template>
                      </div>
                    </template>
                  </div>
                </details>
              </template>
            </div>
          </section>

          <div class="compose-pubbar" x-show="brand" x-cloak>
            <div class="seg">
              <button type="button" :class="publishMode==='draft' ? 'on' : ''" @click="publishMode='draft'">Draft</button>
              <button type="button" :class="publishMode==='now' ? 'on' : ''" @click="publishMode='now'">Publish now</button>
              <button type="button" :class="publishMode==='schedule' ? 'on' : ''" @click="publishMode='schedule'">Schedule</button>
            </div>
            <template x-if="publishMode==='schedule'">
              <label class="when"><input type="datetime-local" x-model="scheduleAt" :min="minAt()" /></label>
            </template>
            <span class="pubbar-grow"></span>
            <button class="btn btn-primary" type="submit" x-bind:disabled="!canSubmit()" x-text="submitLabel()"></button>
          </div>
        </form>

        <aside class="compose-preview" x-show="brand" x-cloak>
          <div class="panel-head" style="padding-left:0;padding-right:0;border:0"><h3>Live preview</h3><span class="panel-sub">per channel</span></div>
          <template x-if="selectedPlatforms().length === 0">
            <p class="card-hint"><small>Select at least one channel.</small></p>
          </template>
          <template x-if="selectedPlatforms().length">
            <div>
              <div class="pv-tabs">
                <template x-for="p in selectedPlatforms()" :key="'pv-'+p.platform">
                  <button type="button" class="pv-tab" :class="pvKey()===p.platform ? 'on' : ''" :style="pvKey()===p.platform ? ('color:'+p.color) : ''" @click="pvTab=p.platform" :title="p.name" x-html="p.glyph"></button>
                </template>
              </div>
              <div class="device">
                <template x-if="pvPlatform()">
                  <article class="pv-card">
                    <header class="pv-head">
                      <span class="pv-av" :style="'background:'+pvPlatform().color" x-html="pvPlatform().glyph"></span>
                      <span class="pv-id"><span class="pv-nm" x-text="brands[brand].name"></span><span class="pv-hd" x-text="pvPlatform().label"></span></span>
                    </header>
                    <div class="pv-media">
                      <template x-if="previewImg()"><img :src="previewImg()" alt="" onerror="this.style.display='none'" /></template>
                      <template x-if="!previewImg()"><span class="pv-media-empty" x-text="mediaUrl ? 'video' : 'no media yet'"></span></template>
                    </div>
                    <p class="pv-cap" x-text="captionFor(pvKey()) || 'No caption'"></p>
                    <div class="pv-foot"><span class="compose-counter" :class="over(pvKey()) ? 'over' : ''"><span x-text="count(pvKey())"></span> / <span x-text="limit(pvKey())"></span></span></div>
                  </article>
                </template>
              </div>
            </div>
          </template>
        </aside>
      </div>
      <script id="ps-compose-data" type="application/json">${raw(json)}</script>
      <script id="ps-compose-seq" type="application/json">${raw(seqJson)}</script>
      ${composeScript()}`,
  });
}

export function registerCompose(r: Hono, guard: MiddlewareHandler): void {
  r.get("/compose", guard, async (c) => {
    const a = await auth(c);
    if (!a) return c.redirect("/login");
    const lic = await getInstanceLicense();
    return c.html(composePage(await brandsData(a.workspaceId), lic.features, lic.products, await loadActiveSequences(a.workspaceId)));
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
      return c.html(composePage(await brandsData(a.workspaceId), lic.features, lic.products, await loadActiveSequences(a.workspaceId), "Could not read the form — please try again."), 400);
    }
    const { contentId, postIds } = await composeContent(parsed, a.workspaceId);
    const mode = parsed.publish?.mode ?? "draft";
    if (mode === "now" || mode === "schedule") {
      const when = mode === "schedule" ? (parsed.publish?.at ?? "now") : "now";
      await publishPosts(postIds, when, a.workspaceId);
    }
    return c.redirect(`/content/${contentId}`, 303);
  });
}
