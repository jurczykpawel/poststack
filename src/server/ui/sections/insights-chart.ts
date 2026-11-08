import { html } from "hono/html";
import type { AccountReport } from "@/lib/insights/service";
import type { InsightMetric } from "@/lib/insights/types";

type Html = ReturnType<typeof html>;
type Point = { day: string; value: string | null; provisional: boolean; x: number; y: number | null };

const W = 700, AXIS = 170, TOP = 14, LEFT = 46, RIGHT = 688, LABEL_Y = 190;
const DAY = 86400000;

/** Groups the integer digits of a stored decimal string; never converts it to a JS number. */
export function groupDecimal(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function formatMetricValue(metric: Pick<InsightMetric, "unit">, value: string): string {
  if (metric.unit === "percent") return `${value}%`;
  if (metric.unit === "milliseconds") return `${groupDecimal(value)} ms`;
  return groupDecimal(value);
}

/** Provider calendar days of [from, toExclusive). Noon UTC of each start keeps the provider's date. */
export function reportDays(report: Pick<AccountReport, "coverage">): string[] {
  const from = Date.parse(report.coverage.from), to = Date.parse(report.coverage.toExclusive);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const count = Math.round((to - from) / DAY);
  return Array.from({ length: count }, (_, i) => new Date(from + 12 * 3600000 + i * DAY).toISOString().slice(0, 10));
}

/** "Jan 10" from a provider day string, formatted in UTC so the day never shifts. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

function niceMax(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].find((step) => step * power >= max) ?? 10) * power;
}

const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const round = (n: number) => Math.round(n * 10) / 10;

/** Daily values of one metric keyed by provider day. */
type DayValue = { value: string | null; provisional: boolean; stale: boolean; partial: boolean };
function dailyValues(report: AccountReport, metricKey: string): Map<string, DayValue> {
  const byDay = new Map<string, DayValue>();
  for (const o of report.series) {
    if (o.metricKey !== metricKey || o.grain !== "day") continue;
    byDay.set(o.providerDay ?? o.snapshotDay, { value: o.state === "available" ? o.value : null, provisional: o.provisional, stale: o.stale, partial: o.partial });
  }
  return byDay;
}

function segments(points: Point[]): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  for (const p of points) {
    if (p.y === null) { if (current.length) out.push(current); current = []; } else current.push(p);
  }
  if (current.length) out.push(current);
  return out;
}

/** Every n-th day plus the last one, skipping a label that would crowd the last. */
function showLabel(i: number, count: number, every: number): boolean {
  if (i === count - 1) return true;
  return i % every === 0 && (every === 1 || count - 1 - i >= every / 2);
}

const pathOf = (points: Point[]) => points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

/** One SSR SVG line chart for a chartable metric plus the same values in an accessible table. */
export function insightsChart(report: AccountReport, metricKey: string): Html {
  const metric = report.catalog.find((m) => m.key === metricKey && m.active && m.chartable);
  if (!metric) return html``;
  const days = reportDays(report);
  const values = dailyValues(report, metricKey);
  const numbers = [...values.values()].flatMap((v) => (v.value === null ? [] : [Number(v.value)]));
  const top = niceMax(Math.max(0, ...numbers));
  const step = days.length > 1 ? (RIGHT - LEFT) / (days.length - 1) : 0;
  const points: Point[] = days.map((day, i) => {
    const v = values.get(day);
    const x = round(days.length > 1 ? LEFT + i * step : (LEFT + RIGHT) / 2);
    const y = v?.value == null ? null : round(AXIS - (Number(v.value) / top) * (AXIS - TOP));
    return { day, value: v?.value ?? null, provisional: !!v?.provisional, x, y };
  });
  const lines = segments(points).map((segment) => {
    const solid = segment.filter((p) => !p.provisional);
    const tail = segment.filter((p) => p.provisional);
    const dashed = tail.length ? [...solid.slice(-1), ...tail] : [];
    return html`${solid.length ? html`<path class="ins-line" d="${pathOf(solid)}"/>` : ""}${dashed.length ? html`<path class="ins-prov" d="${pathOf(dashed)}"/>` : ""}`;
  });
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const titleId = `ins-chart-title-${metric.key}`, descId = `ins-chart-desc-${metric.key}`;
  const anyValue = points.some((p) => p.y !== null);
  const hasGap = anyValue && points.some((p) => p.y === null);
  const provisional = points.some((p) => p.provisional && p.y !== null);
  const stale = [...values.values()].some((v) => v.stale);
  const partial = [...values.values()].some((v) => v.partial);
  const first = days[0] ?? "", last = days.at(-1) ?? "";
  const columns = report.catalog.filter((m) => m.active && m.chartable).sort((a, b) => (a.cardOrder ?? 99) - (b.cardOrder ?? 99));
  const table = columns.map((m) => ({ metric: m, values: dailyValues(report, m.key) }));

  return html`<div class="ins-chart">
    <svg viewBox="0 0 ${W} 200" role="img" aria-labelledby="${titleId} ${descId}" preserveAspectRatio="xMidYMid meet">
      <title id="${titleId}">${metric.label} per day</title>
      <desc id="${descId}">Daily ${metric.label.toLowerCase()} for provider days ${first} to ${last}. Breaks in the line are days without data${provisional ? "; the dashed part is provisional" : ""}.</desc>
      <line class="ins-grid" x1="${LEFT}" y1="${TOP}" x2="${RIGHT}" y2="${TOP}"/>
      <line class="ins-grid" x1="${LEFT}" y1="${round((AXIS + TOP) / 2)}" x2="${RIGHT}" y2="${round((AXIS + TOP) / 2)}"/>
      <line class="ins-axis" x1="${LEFT}" y1="${AXIS}" x2="${RIGHT}" y2="${AXIS}"/>
      <g class="ins-tl">
        <text x="${LEFT - 8}" y="${TOP + 4}" text-anchor="end">${compact(top)}</text>
        <text x="${LEFT - 8}" y="${round((AXIS + TOP) / 2) + 4}" text-anchor="end">${compact(top / 2)}</text>
        <text x="${LEFT - 8}" y="${AXIS + 4}" text-anchor="end">0</text>
        ${points.map((p, i) => showLabel(i, points.length, labelEvery)
          ? html`<text x="${p.x}" y="${LABEL_Y}" text-anchor="middle">${dayLabel(p.day)}${p.provisional ? "*" : ""}</text>` : "")}
      </g>
      ${lines}
      ${points.filter((p) => p.y !== null).map((p) => html`<circle class="${p.provisional ? "ins-dot ins-dot-prov" : "ins-dot"}" data-day="${p.day}" data-value="${p.value}" cx="${p.x}" cy="${p.y}" r="3"/>`)}
      ${anyValue ? "" : html`<text class="ins-none" x="${(LEFT + RIGHT) / 2}" y="${round((AXIS + TOP) / 2)}" text-anchor="middle">No data for this period</text>`}
    </svg>
    ${provisional ? html`<p class="ins-note">The platform can still update the last 48 hours. Provisional days (*) use a dashed line.</p>` : ""}
    ${hasGap ? html`<p class="ins-note">Some days have no data yet, so the line breaks there. A break is missing data, not zero.</p>` : ""}
    ${partial ? html`<p class="ins-note">For days marked partial the platform sent only the end time, so their start time is estimated. Their values are shown but not added into totals.</p>` : ""}
    ${stale ? html`<p class="ins-note">Showing the last collected data; some values were collected more than 48 hours ago.</p>` : ""}
    <details class="ins-table">
      <summary>Show data as a table</summary>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Provider day</th>${table.map((c) => html`<th scope="col">${c.metric.label}</th>`)}</tr></thead>
        <tbody>${days.map((day) => {
          const marks = (["provisional", "partial"] as const).filter((flag) => table.some((c) => c.values.get(day)?.[flag]));
          return html`<tr><th scope="row">${day}${marks.length ? ` (${marks.join(", ")})` : ""}</th>${table.map((c) => {
            const value = c.values.get(day)?.value;
            return html`<td>${value == null ? "—" : formatMetricValue(c.metric, value)}</td>`;
          })}</tr>`;
        })}</tbody>
      </table></div>
    </details>
  </div>`;
}
