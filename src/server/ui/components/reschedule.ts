import { html } from "hono/html";

/** Reuses the browser-timezone and DST interpretation used by Compose. */
export function rescheduleForm(action: string, target: string) {
  return html`<details class="reschedule"><summary class="btn btn-secondary btn-sm">Zmień termin</summary>
    <form method="post" action="${action}" hx-post="${action}" hx-target="${target}" hx-swap="outerHTML"
      x-data="psReschedule" :hx-confirm="confirmation" data-confirm-label="Zapisz termin">
      <label>Nowy termin <input required type="datetime-local" x-model="local" :min="minLocal" aria-label="Nowy termin" /></label>
      <input type="hidden" name="scheduledAt" :value="iso" />
      <p class="notice notice-warn" role="status" x-show="notice" x-text="notice" x-cloak></p>
      <p class="muted" x-text="preview"></p>
      <p class="muted">Post wyjdzie automatycznie o nowej godzinie z zapisanymi ustawieniami. Zgoda i opcje TikTok Direct Post pozostają bez zmian.</p>
      <button class="btn btn-primary btn-sm" type="submit" :disabled="!valid">Zapisz termin</button>
    </form>
  </details>`;
}
