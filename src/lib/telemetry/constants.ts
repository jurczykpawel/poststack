// Fixed, non-secret telemetry constants. The project identifier the receiver buckets on, plus the
// send-cadence windows, are part of the product behaviour (not deployment config) — so they live in
// source, not env.
export const TELEMETRY_PROJECT = "poststack";

/** ~Daily cadence gate: a successful report suppresses further sends for this long. */
export const SEND_WINDOW_MS = 20 * 60 * 60 * 1000;
/** Retry lease: an in-flight/failed claim is not re-attempted within this window (debounces restarts). */
export const RETRY_LEASE_MS = 60 * 60 * 1000;
