// Pure presentation logic for FleetStats — extracted from the component so it can be unit-tested
// without a DOM. The component's inline script imports these; behavior must stay identical.

/** The aggregate, anonymous numbers the public telemetry endpoint returns. All fields optional —
 *  a down/old endpoint may omit any of them, and the selectors are robust to that. */
export interface FleetResponse {
  active_instances?: number;
  total_messages_processed?: number;
  total_webhooks_processed?: number;
  total_channels?: number;
  avg_response_time_ms?: number;
  /** Connected channels grouped by platform (e.g. { facebook: 24, instagram: 14 }). Counts only. */
  by_platform?: Record<string, number>;
}

/** How a metric's number is rendered: a plain count, or a human-friendly duration. */
export type FleetMetricKind = "count" | "duration";

/** A configured display metric (key into FleetResponse + its render kind). */
export interface FleetMetricDef {
  key: keyof FleetResponse;
  kind: FleetMetricKind;
}

/** A resolved display row: the formatted text, or `visible: false` when the field is missing/invalid. */
export interface FleetMetricRow {
  key: keyof FleetResponse;
  visible: boolean;
  text: string;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Locale-aware thousands separators for whole counts. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Human-friendly first-response time: ~Nms under a second, ~Ns under a minute, ~Nm above. null → "—". */
export function formatLatency(ms: number | null): string {
  if (!isFiniteNumber(ms)) return "—";
  if (ms < 1000) return `~${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)}m`;
}

/** Reveal the section only on real adoption: a finite active_instances strictly greater than zero.
 *  A down endpoint (no/invalid field) or an empty fleet (0) stays hidden. */
export function shouldReveal(stats: FleetResponse | null | undefined): boolean {
  return !!stats && isFiniteNumber(stats.active_instances) && stats.active_instances > 0;
}

/** Map the API response to display rows for the given metric definitions. A missing/non-finite field
 *  yields `visible: false` (the component collapses that card) rather than a placeholder or a zero. */
export function selectMetrics(stats: FleetResponse, defs: readonly FleetMetricDef[]): FleetMetricRow[] {
  return defs.map((def) => {
    const raw = stats[def.key];
    if (!isFiniteNumber(raw)) return { key: def.key, visible: false, text: "—" };
    const text = def.kind === "duration" ? formatLatency(raw) : formatCount(raw);
    return { key: def.key, visible: true, text };
  });
}

/** One platform's share of the connected-channel fleet, ready to render as a labelled bar. */
export interface PlatformBar {
  /** Lowercase platform id from the API (e.g. "facebook") — used for the icon lookup. */
  key: string;
  /** Display label (Title Case), e.g. "Facebook". */
  label: string;
  /** Channel count on this platform. */
  count: number;
  /** Formatted count with thousands separators. */
  text: string;
  /** Bar width as a percentage of the largest platform (0–100), so the leader fills the track. */
  pct: number;
}

/** Title-case a lowercase platform id for display ("youtube" → "Youtube"); known multi-case brands
 *  (YouTube, LinkedIn, TikTok) are special-cased so the label reads right. */
export function platformLabel(key: string): string {
  const special: Record<string, string> = {
    youtube: "YouTube",
    linkedin: "LinkedIn",
    tiktok: "TikTok",
    x: "X",
    twitter: "X",
  };
  return special[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Turn `by_platform` into sorted, normalised bars (largest first). Non-finite or non-positive
 *  counts are dropped; widths are relative to the largest so the leader always fills the track.
 *  Returns [] when there is no usable platform data (the component then hides the breakdown). */
export function selectPlatformBars(stats: FleetResponse, opts: { maxBars?: number } = {}): PlatformBar[] {
  const raw = stats.by_platform;
  if (!raw || typeof raw !== "object") return [];
  const rows = Object.entries(raw)
    .filter(([, v]) => isFiniteNumber(v) && v > 0)
    .map(([key, count]) => ({ key, count: count as number }))
    .sort((a, b) => b.count - a.count);
  if (rows.length === 0) return [];
  const max = rows[0]!.count;
  const limited = typeof opts.maxBars === "number" ? rows.slice(0, opts.maxBars) : rows;
  return limited.map(({ key, count }) => ({
    key,
    label: platformLabel(key),
    count,
    text: formatCount(count),
    pct: Math.max(6, Math.round((count / max) * 100)), // floor of 6% so the smallest bar stays visible
  }));
}
