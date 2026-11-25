import { SCHEDULE_HORIZON_DAYS } from "@/lib/deliveries/schedule";
import { html } from "hono/html";

/** Reuses the browser-timezone and DST interpretation used by Compose. */
export function rescheduleForm(action: string, target: string) {
  return html`<details class="reschedule"><summary class="btn btn-secondary btn-sm">Reschedule</summary>
    <form method="post" action="${action}" hx-post="${action}" hx-target="${target}" hx-swap="outerHTML" hx-push-url="false"
      x-data="psReschedule" data-horizon-days="${SCHEDULE_HORIZON_DAYS}" :hx-confirm="confirmation" data-confirm-label="Save new time">
      <label>New time <input required type="datetime-local" x-model="local" :min="minLocal" aria-label="New time" aria-describedby="reschedule-guidance" /></label>
      <input type="hidden" name="scheduledAt" :value="iso" />
      <p class="notice notice-warn" role="status" x-show="notice" x-text="notice" x-cloak></p>
      <p id="reschedule-guidance" class="muted" role="status" x-text="validation" x-show="validation">Choose a future date and time to save.</p>
      <p class="muted" x-text="preview"></p>
      <p class="muted">The post goes out automatically at the new time with its saved settings. TikTok Direct Post consent and options stay as they are.</p>
      <button class="btn btn-primary btn-sm" type="submit" :disabled="!valid">Save new time</button>
    </form>
  </details>`;
}
