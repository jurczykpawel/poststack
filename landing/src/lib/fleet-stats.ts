// Pure presentation logic for FleetStats — extracted from the component so it can be unit-tested
// without a DOM. The component's inline script imports these; behavior must stay identical.

/** The aggregate, anonymous numbers the public telemetry endpoint returns. All fields optional —
 *  a down/old endpoint may omit any of them, and selectMetrics is robust to that. */
export interface FleetResponse {
  active_instances?: number;
  total_messages_processed?: number;
  total_webhooks_processed?: number;
  total_channels?: number;
  avg_response_time_ms?: number;
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
