import { html } from "hono/html";

type Html = ReturnType<typeof html>;

/**
 * Account identity for list/table cells: the friendly name on top with the canonical provider id
 * (e.g. a YouTube `UC…` channel id) muted + monospace beneath it. When there's no display name the
 * id stands alone as the primary label. Matching is always by the id; the name is presentation only.
 */
export function accountCell(
  displayName: string | null | undefined,
  providerAccountId: string,
  avatarUrl?: string | null,
  handle?: string | null,
): Html {
  // Only trust an https image; hide it on load error (the platform-icon column still identifies the row).
  const avatar =
    avatarUrl && avatarUrl.startsWith("https://")
      ? html`<img class="acct-avatar" src="${avatarUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
      : "";
  // Normalize handle: prepend @ if missing.
  const h = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : null;
  // Show handle only when it adds info (different from both displayName and providerAccountId).
  const handleBit =
    h && h !== displayName && h !== providerAccountId
      ? html`<span class="acct-handle">${h}</span>`
      : "";
  if (!displayName) return html`<span class="acct acct-solo">${avatar}<span class="acct-id-solo">${providerAccountId}</span></span>`;
  return html`<span class="acct">
    ${avatar}
    <span class="acct-text">
      <span class="acct-name">${displayName}</span>
      ${handleBit}
      <span class="acct-id">${providerAccountId}</span>
    </span>
  </span>`;
}
