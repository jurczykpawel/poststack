import { html, raw } from "hono/html";

type Html = ReturnType<typeof html>;

// Shared Alpine click handler: copy this element's data-copy to the clipboard, then flip `copied`
// for ~1.2s. Inlined via raw() because hono/html would otherwise escape the `=>`/`>` in the JS.
const copyAction = raw(
  "navigator.clipboard.writeText($el.dataset.copy); copied = true; setTimeout(() => (copied = false), 1200)",
);

/**
 * A clipboard button (Alpine). The text to copy rides in `data-copy` (escaped by hono/html), so even
 * long captions with quotes/newlines are safe. On click it writes to the clipboard and flips its
 * label to "Copied" for ~1.2s. No-JS: the button is inert (the text is visible elsewhere on the card).
 * `label` is a controlled, quote-free literal (e.g. "Copy", "Copy cover").
 */
export function copyBtn(text: string, label = "Copy"): Html {
  const xText = raw(`x-text="copied ? 'Copied' : '${label}'"`);
  return html`<button
    type="button"
    class="copy-btn"
    data-copy="${text}"
    x-data="{ copied: false }"
    @click="${copyAction}"
    ${xText}
  >${label}</button>`;
}

/**
 * An inline value that copies itself to the clipboard when clicked (Alpine). Renders the text as
 * monospace `<code>`; the whole control is a button (keyboard: Enter/Space) and briefly shows a
 * "Copied" flag. The text rides in `data-copy` (escaped by hono/html). No-JS: the value stays
 * visible and selectable, so it can still be copied manually. Used for OAuth redirect URIs.
 */
export function copyableCode(text: string): Html {
  return html`<span
    class="copyable"
    role="button"
    tabindex="0"
    title="Click to copy"
    aria-label="Copy to clipboard"
    data-copy="${text}"
    x-data="{ copied: false }"
    @click="${copyAction}"
    @keydown.enter.prevent="${copyAction}"
    @keydown.space.prevent="${copyAction}"
  ><code class="meta-mono copyable-code">${text}</code><span class="copyable-flag" x-show="copied" x-cloak>Copied</span></span>`;
}
