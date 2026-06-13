import { html } from "hono/html";

type Html = ReturnType<typeof html>;

/**
 * "All / None" toggle for a checkbox <fieldset>. The fieldset must carry `x-data` so Alpine's `$root`
 * resolves to it; the buttons flip every checkbox inside that fieldset (and nothing outside it).
 * Relies on the admin CSP allowing 'unsafe-eval' (vendored Alpine evaluates the expression).
 */
export function checkAllToggle(): Html {
  return html`<span class="check-all">
    <button type="button" class="link-btn" @click="$root.querySelectorAll('input[type=checkbox]').forEach(c=>{c.checked=true})">All</button>
    <span class="check-all-sep">·</span>
    <button type="button" class="link-btn" @click="$root.querySelectorAll('input[type=checkbox]').forEach(c=>{c.checked=false})">None</button>
  </span>`;
}
