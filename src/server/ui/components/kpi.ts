import { html } from "hono/html";
import { dot, type Tone } from "./status";

type Html = ReturnType<typeof html>;

export interface KpiOpts {
  value: number | string;
  label: string;
  tone: Tone;
  /** Optional mono caption shown next to the value (e.g. "next 22m"). */
  sub?: string;
  /** Optional link target — wraps the whole card in an anchor. */
  href?: string;
}

/** A single dashboard KPI card: mono value tinted by tone, uppercase label with a tone dot. */
export function kpi(o: KpiOpts): Html {
  const inner = html`<div class="kpi-top">
      <span class="kpi-n tone-${o.tone}">${o.value}</span>
      ${o.sub ? html`<span class="kpi-sub">${o.sub}</span>` : ""}
    </div>
    <div class="kpi-l">${dot(o.tone)}${o.label}</div>`;
  return o.href
    ? html`<a class="kpi" href="${o.href}">${inner}</a>`
    : html`<div class="kpi">${inner}</div>`;
}
