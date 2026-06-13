import { html } from "hono/html";
type Html = ReturnType<typeof html>;
export type Tone = "ok" | "warn" | "bad" | "neutral" | "info";

// channel.status → [tone, label]; post.status → tone (label = the status string)
const CHANNEL_TONE: Record<string, [Tone, string]> = {
  active: ["ok", "Healthy"], needs_reauth: ["warn", "Needs reauth"],
  paused: ["neutral", "Paused"], disabled: ["neutral", "Disabled"],
};
const POST_TONE: Record<string, Tone> = {
  planned: "neutral", scheduled: "info", publishing: "info", sending: "info", sent: "ok",
  published: "ok", published_external: "neutral", held: "warn",
  failed: "bad", canceled: "neutral", unknown: "warn", needs_attention: "warn",
};
// Friendlier labels for editorial post statuses (default = the raw status string).
const POST_LABEL: Record<string, string> = {
  planned: "Planned", publishing: "Publishing…", published: "Published",
  published_external: "Published elsewhere", needs_attention: "Needs attention",
};
// webhook_delivery.status → tone (label = the status string)
const DELIVERY_TONE: Record<string, Tone> = {
  pending: "neutral", delivering: "info", delivered: "ok", failed: "bad",
};

export function statusBadge(status: string): Html {
  const channel = CHANNEL_TONE[status];
  const tone: Tone = channel?.[0] ?? POST_TONE[status] ?? "neutral";
  const label = channel?.[1] ?? POST_LABEL[status] ?? status;
  return html`<span class="badge tone-${tone}">${label}</span>`;
}

/** Tone for an editorial post status (for compact dots/strips). */
export function postTone(status: string): Tone {
  return POST_TONE[status] ?? "neutral";
}

/** Badge for a webhook delivery status (pending / delivering / delivered / failed). */
export function deliveryBadge(status: string): Html {
  const tone: Tone = DELIVERY_TONE[status] ?? "neutral";
  return html`<span class="badge tone-${tone}">${status}</span>`;
}
export function pill(text: string, tone: Tone): Html {
  return html`<span class="pill tone-${tone}">${text}</span>`;
}
export function dot(tone: Tone): Html {
  return html`<span class="dot tone-${tone}" aria-hidden="true"></span>`;
}
