// Meta messaging-window state for a conversation. Meta only lets you send a DM via the API within
// the 24h "standard messaging window" since the user's last message; past that, `messaging_type:
// RESPONSE` is rejected (#10 / subcode 2018278). A human agent answering the customer may instead
// use the HUMAN_AGENT message tag, which extends the window to 7 days. This module is the single
// source of truth for: (a) whether a manual reply should carry the HUMAN_AGENT tag, and (b) the
// heads-up label the inbox shows. Pure + side-effect-free so both the send worker and the UI share it.

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h RESPONSE window
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d HUMAN_AGENT tag window
export const CLOSING_SOON_MS = 6 * 60 * 60 * 1000; // warn when <6h of the 24h window remain

/** Platforms with the Meta 24h DM window. Comment threads and non-Meta platforms are exempt. */
const META_DM_PLATFORMS = new Set(["facebook", "instagram"]);

export type MessagingWindowKind = "na" | "open" | "closing_soon" | "human_agent" | "expired";

export interface MessagingWindowState {
  kind: MessagingWindowKind;
  /** ms until the 24h standard window closes — only meaningful for `open`/`closing_soon`. */
  closesInMs: number | null;
  /** True when a manual human reply should be sent with the HUMAN_AGENT tag (i.e. past 24h). */
  useHumanAgentTag: boolean;
  /** Operator-facing heads-up for the composer; null when nothing needs saying. */
  label: string | null;
}

function formatDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}

export function messagingWindowState(opts: {
  platform: string;
  threadType?: string | null;
  lastInboundAt: Date | null;
  now?: Date;
}): MessagingWindowState {
  const now = opts.now ?? new Date();

  // The window only governs Meta DMs. Treat a missing threadType as a DM (Meta conversations are
  // DMs unless explicitly a comment thread).
  const isMetaDm = META_DM_PLATFORMS.has(opts.platform) && (!opts.threadType || opts.threadType === "dm");
  if (!isMetaDm) {
    return { kind: "na", closesInMs: null, useHumanAgentTag: false, label: null };
  }

  // No inbound on record → we can't be inside the standard window; a human reply needs the tag.
  if (!opts.lastInboundAt) {
    return {
      kind: "expired",
      closesInMs: null,
      useHumanAgentTag: true,
      label: "No prior inbound message — Meta may reject this reply.",
    };
  }

  const elapsed = now.getTime() - opts.lastInboundAt.getTime();

  if (elapsed < STANDARD_WINDOW_MS) {
    const closesInMs = STANDARD_WINDOW_MS - elapsed;
    if (closesInMs <= CLOSING_SOON_MS) {
      return {
        kind: "closing_soon",
        closesInMs,
        useHumanAgentTag: false,
        label: `24h reply window closes in ${formatDuration(closesInMs)}.`,
      };
    }
    return { kind: "open", closesInMs, useHumanAgentTag: false, label: null };
  }

  if (elapsed < HUMAN_AGENT_WINDOW_MS) {
    return {
      kind: "human_agent",
      closesInMs: null,
      useHumanAgentTag: true,
      label: "24h window closed — sending as a human-agent message (allowed up to 7 days).",
    };
  }

  return {
    kind: "expired",
    closesInMs: null,
    useHumanAgentTag: true,
    label: "⏰ Outside the 7-day messaging window — Meta will likely reject this reply.",
  };
}
