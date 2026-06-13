import { html } from "hono/html";

type Html = ReturnType<typeof html>;

/**
 * The scheme chokepoint for any DB/provider/user-controlled URL that reaches an `href`/`src`.
 * Returns the URL only when it is an absolute http(s) URL, else `null`. hono/html escapes the
 * interpolated value (no attribute breakout), but escaping does NOT stop a dangerous *scheme* —
 * a `javascript:`/`data:` URL in an href still executes on click. Anchored `^https?://` also
 * rejects protocol-relative (`//host`) and leading-whitespace tricks.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Render a stored URL as an outbound link iff it is http(s); otherwise as inert, escaped `<code>`
 * text (the value is still shown for debugging, but can never run as a link). `label` defaults to
 * the URL itself. Empty/absent URL renders nothing.
 */
export function urlLink(url: string | null | undefined, label?: string, cls = "meta-mono"): Html {
  if (!url) return html``;
  const safe = safeHttpUrl(url);
  return safe
    ? html`<a class="${cls}" href="${safe}" target="_blank" rel="noopener noreferrer">${label ?? url}</a>`
    : html`<code class="${cls}">${url}</code>`;
}
