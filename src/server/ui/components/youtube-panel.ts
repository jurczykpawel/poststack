import { html } from "hono/html";
import { assetUrl } from "../assets";

export function youtubePanelScript() {
  return html`<script src="${assetUrl("youtube-panel.js")}"></script>`;
}

// YouTube's standard assignable categories (ids are the same worldwide).
const CATEGORIES: [string, string][] = [
  ["1", "Film & Animation"], ["2", "Autos & Vehicles"], ["10", "Music"], ["15", "Pets & Animals"], ["17", "Sports"],
  ["19", "Travel & Events"], ["20", "Gaming"], ["22", "People & Blogs"], ["23", "Comedy"], ["24", "Entertainment"],
  ["25", "News & Politics"], ["26", "Howto & Style"], ["27", "Education"], ["28", "Science & Technology"], ["29", "Nonprofits & Activism"],
];

/** Host provides yt (psYouTubePanel), isOn('youtube') and publishMode. Field names match the public API. */
export function youtubePanel() {
  return html`<section class="panel youtube-panel" aria-label="YouTube publishing" x-show="isOn('youtube')" x-cloak>
    <div class="panel-head"><h3>YouTube</h3></div>
    <div class="compose-body">
      <label class="fld"><span>Visibility</span><select data-ps-raw x-model="yt.privacy" aria-label="YouTube visibility">
        <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></label>
      <label class="fld"><span>Category</span><select data-ps-raw x-model="yt.categoryId" aria-label="YouTube category">
        <option value="">YouTube default</option>${CATEGORIES.map(([id, name]) => html`<option value="${id}">${name}</option>`)}</select></label>
      <label class="fld"><span>Tags <small>(comma separated)</small></span><input type="text" x-model="yt.tags" aria-label="YouTube tags" /></label>
      <p class="notice notice-warn" role="alert" x-show="yt.tagsError" x-text="yt.tagsError" x-cloak></p>
      <label class="fld"><span>Made for kids</span><select data-ps-raw x-model="yt.kids" aria-label="Made for kids">
        <option value="">Select…</option><option value="no">No, not made for kids</option><option value="yes">Yes, made for kids</option></select></label>
      <p class="notice notice-warn" role="status" x-show="yt.kids === '' &amp;&amp; publishMode !== 'draft'" x-cloak>Choose whether this video is made for kids before publishing.</p>
      <label class="fld"><span>Altered or synthetic content</span><select data-ps-raw x-model="yt.ai" aria-label="Altered or synthetic content">
        <option value="">Not declared</option><option value="none">No AI-generated content</option><option value="ai_assisted">AI-assisted</option><option value="ai_generated">AI-generated</option></select></label>
      <label class="fld"><span>License</span><select data-ps-raw x-model="yt.license" aria-label="YouTube license">
        <option value="">YouTube default</option><option value="youtube">Standard YouTube license</option><option value="creativeCommon">Creative Commons – Attribution</option></select></label>
      <label class="compose-toggle"><input type="checkbox" x-model="yt.embeddable" /><span>Allow embedding</span></label>
      <label class="compose-toggle"><input type="checkbox" x-model="yt.stats" /><span>Show extended statistics publicly</span></label>
      <label class="compose-toggle"><input type="checkbox" x-model="yt.notify" /><span>Notify subscribers</span></label>
      <label class="fld"><span>Video language <small>(e.g. pl, en)</small></span><input type="text" x-model="yt.language" maxlength="15" aria-label="Video language" /></label>
      <p class="notice notice-warn" role="alert" x-show="yt.languageError" x-text="yt.languageError" x-cloak></p>
      <label class="fld"><span>Recording date</span><input type="date" x-model="yt.recordingDate" aria-label="Recording date" /></label>

      <fieldset style="border:0;padding:0"><legend>Chapters</legend>
        <p class="card-hint">At least 3, the first at 00:00, each at least 10 seconds long. Added to the end of the description.</p>
        <template x-for="(c, i) in yt.chapters" :key="i">
          <div class="fld-row">
            <input type="text" x-model="c.start" @change="yt.sortChapters()" placeholder="00:00" size="8" :aria-label="'Chapter ' + (i + 1) + ' start'" />
            <input type="text" x-model="c.title" maxlength="100" placeholder="Chapter title" :aria-label="'Chapter ' + (i + 1) + ' title'" />
            <button type="button" @click="yt.removeChapter(i)" :aria-label="'Remove chapter ' + (i + 1)">Remove</button>
          </div>
        </template>
        <button type="button" @click="yt.addChapter()">Add chapter</button>
        <p class="notice notice-warn" role="alert" x-show="yt.chapterError" x-text="yt.chapterError" x-cloak></p>
      </fieldset>

      <fieldset style="border:0;padding:0"><legend>Translations</legend>
        <template x-for="(l, i) in yt.localizations" :key="i">
          <div class="fld-row">
            <input type="text" x-model="l.lang" maxlength="15" placeholder="en" size="6" :aria-label="'Translation ' + (i + 1) + ' language'" />
            <input type="text" x-model="l.title" maxlength="100" placeholder="Title" :aria-label="'Translation ' + (i + 1) + ' title'" />
            <input type="text" x-model="l.description" maxlength="5000" placeholder="Description" :aria-label="'Translation ' + (i + 1) + ' description'" />
            <button type="button" @click="yt.removeLocalization(i)" :aria-label="'Remove translation ' + (i + 1)">Remove</button>
          </div>
        </template>
        <button type="button" @click="yt.addLocalization()">Add translation</button>
        <p class="notice notice-warn" role="alert" x-show="yt.localizationError" x-text="yt.localizationError" x-cloak></p>
      </fieldset>

      <p class="card-hint">Age restriction, playlists and subtitles are not set from here. Set them in YouTube Studio after upload.</p>
    </div>
  </section>`;
}
