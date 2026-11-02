import type { Tone } from "../components/status";

// Plain-language meaning of each inbound webhook handling status, for the /webhooks legend and the Activity webhook log.
export const WEBHOOK_STATUS_LEGEND: ReadonlyArray<readonly [string, Tone, string]> = [
  ["fired", "ok", "Matched an active rule — an auto-reply was sent or queued."],
  ["recorded", "info", "Stored for engagement only (a like/reaction on your post) — no rule runs on these."],
  ["received", "neutral", "Arrived and logged, still being processed (transient)."],
  ["no_match", "neutral", "Valid event, but no rule's keywords/trigger matched."],
  ["paused", "warn", "A rule would match, but it's currently paused."],
  ["ignored", "neutral", "Intentionally skipped — e.g. your own echo or a duplicate."],
  ["unhandled", "neutral", "An event type the app doesn't act on."],
  ["error", "bad", "Processing failed — open the event for details."],
  // OBS1: endpoint-level outcomes that never became an event (no channel) — see "Endpoint activity".
  ["handshake_ok", "ok", "Meta verified your webhook subscription (the GET challenge succeeded)."],
  ["handshake_fail", "bad", "A subscription verification was refused — wrong/absent verify token or unexpected mode."],
  ["rejected_signature", "bad", "A POST was refused before processing — its signature didn't match your app secret."],
  ["rejected_parse", "bad", "A POST body wasn't valid JSON — refused before processing."],
  ["rejected_object", "warn", "A POST for an object type the app doesn't handle — recorded, not processed."],
  ["rejected_too_large", "bad", "A POST body exceeded the size cap — refused before buffering."],
];
// OBS1: the endpoint-activity statuses (handshake + rejected-before-record). These rows have no
// channel, so they live in their own instance-wide list rather than the per-channel incoming log.
export const WEBHOOK_ENDPOINT_STATUSES = [
  "handshake_ok", "handshake_fail", "rejected_signature", "rejected_parse", "rejected_object", "rejected_too_large",
] as const;
export const WEBHOOK_STATUS_TONE: Record<string, Tone> = Object.fromEntries(WEBHOOK_STATUS_LEGEND.map(([s, tone]) => [s, tone]));
