import { html } from "hono/html";
import { assetUrl } from "../assets";

export function tiktokPanelScript() {
  return html`<script src="${assetUrl("tiktok-panel.js")}"></script>`;
}

/** Host provides tt (psTikTokPanel), mediaUrl, coverUrl, captionFor('tiktok'), sel.tiktok.override,
 *  isOn('tiktok'), publishMode, tiktokScheduleText() and tiktokConsentKey().
 *  Recreate tt with the current creator result and channel id for every confirmation screen.
 *  The host route enables HTTPS video playback in its document policy, as Compose does. */
export function tiktokPanel() {
  return html`<section class="panel tiktok-panel" aria-label="TikTok publishing" x-show="isOn('tiktok')" x-cloak
    x-effect="if (tt.consent &amp;&amp; tt.consentKey !== tiktokConsentKey()) tt.consent = false">
    <div class="panel-head"><h3>TikTok</h3></div>
    <div class="compose-body">
      <p>Creator: <strong x-text="tt.info ? tt.info.creator_nickname : 'Unavailable'"></strong></p>
      <label class="fld"><span>TikTok delivery</span><select data-ps-raw x-model="tt.mode" aria-label="TikTok delivery">
        <option value="inbox">Send to TikTok inbox (finish in TikTok)</option><option value="direct">Direct Post</option>
      </select></label>
      <p class="notice notice-warn" role="status" x-show="tt.unavailable">TikTok cannot accept posts right now. Try again later.</p>
      <div x-show="tt.mode === 'direct'">
        <label class="fld"><span>Who can view this video?</span><select data-ps-raw x-model="tt.privacy" aria-label="TikTok privacy" :disabled="tt.unavailable">
          <option value="" disabled>Select who can view</option>
          <template x-for="opt in tt.privacyOptionsView" :key="opt.value">
            <option :value="opt.value" :disabled="opt.disabled" :title="opt.note" x-text="opt.label"></option>
          </template>
        </select></label>
        <fieldset style="border:0;padding:0"><legend>Interactions</legend>
          ${([ ["Comment", "comment"], ["Duet", "duet"], ["Stitch", "stitch"] ] as const).map(([label, kind]) => html`
            <label class="compose-toggle" :title="tt.interactionNote('${kind}')">
              <input type="checkbox" x-model="tt.allow${label}" :disabled="tt.interactionDisabled('${kind}')" :title="tt.interactionNote('${kind}')" />
              <span>Allow ${label}</span>
            </label>`)}
        </fieldset>
        <p class="card-hint">Greyed-out interactions are disabled in the creator’s TikTok account settings.</p>
        <label class="compose-toggle"><input type="checkbox" x-model="tt.disclosure" /><span>Commercial Content Disclosure</span></label>
        <div x-show="tt.disclosure">
          <label class="compose-toggle"><input type="checkbox" x-model="tt.brandYourBrand" /><span>Your brand</span></label>
          <label class="compose-toggle" title="Branded content visibility cannot be set to private">
            <input type="checkbox" x-model="tt.brandedContent" :disabled="tt.brandedContentDisabled" @change="tt.onBrandedContentChange()" /><span>Branded content</span>
          </label>
          <p x-show="tt.brandedContentDisabled">Branded content visibility cannot be set to private</p>
          <p x-show="!tt.brandYourBrand &amp;&amp; !tt.brandedContent" role="status">Select at least one disclosure option.</p>
          <p x-show="tt.disclosureLabel" x-text="tt.disclosureLabel" aria-live="polite"></p>
        </div>
        <p class="card-hint">Until this app passes TikTok review, Direct Posts can only be private. Your visibility choice is never changed automatically.</p>
        <p x-show="tt.info &amp;&amp; tt.info.max_video_post_duration_sec" x-text="'Maximum video length: ' + (tt.info ? Math.min(600, tt.info.max_video_post_duration_sec) : '') + ' seconds'"></p>
        <p class="notice notice-warn" role="alert" x-show="tt.durationExceeded">This video exceeds the creator's maximum video length. Choose a shorter video.</p>
      </div>
      <video x-show="mediaUrl" :src="isOn('tiktok') ? mediaUrl : ''" :poster="coverUrl" controls preload="metadata" aria-label="TikTok video preview"
        style="width:100%;max-height:360px" @loadedmetadata="tt.videoDurationSec = $el.duration" @emptied="tt.videoDurationSec = 0"></video>
      <label class="fld"><span>TikTok caption</span><textarea rows="3" aria-label="TikTok caption" x-model="sel.tiktok.override" :placeholder="captionFor('tiktok')" maxlength="2200"></textarea></label>
      <p class="card-hint" x-text="captionFor('tiktok')"></p>
      <p>Processing may take a few minutes. Check the post's delivery status after submission.</p>
      <div x-show="publishMode !== 'draft'">
        <p x-show="publishMode === 'schedule'" x-text="tiktokScheduleText()" role="status"></p>
        <p>By submitting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.
          <span x-show="tt.mode === 'direct' &amp;&amp; tt.disclosure &amp;&amp; tt.brandedContent">You also agree to the <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener">Branded Content Policy</a>.</span>
        </p>
        <label class="compose-toggle"><input type="checkbox" :checked="tt.consent" @change="tt.confirm(tiktokConsentKey(), $el.checked)" /><span>I confirm this TikTok submission with these settings.</span></label>
      </div>
    </div>
  </section>`;
}
