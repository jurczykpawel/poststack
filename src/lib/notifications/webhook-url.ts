/**
 * Conservative allow-list check for an operator-configured outbound webhook URL (the channel
 * alert hook). Guards against pointing it at a private/link-local address — most
 * importantly the cloud metadata endpoint (169.254.169.254) on managed hosting.
 *
 * Allowed: http or https to a hostname (localhost, a docker-compose service name, a public
 * domain) or to a loopback IP. Rejected: a private/link-local/reserved IP *literal* (RFC1918,
 * 169.254.0.0/16, fc00::/7, fe80::/10, 0.0.0.0/8) and any non-http(s) scheme.
 *
 * This blocks the obvious literal-IP SSRF targets without breaking the common self-host case of
 * an internal hostname over http. It deliberately does NOT resolve DNS, so a hostname that
 * resolves to a private address (DNS rebinding) is out of scope; the alert fetch also uses
 * `redirect: "error"`, so a redirect can't bounce it onto an internal address either.
 */
export function isSafeAlertWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // Strip the [] some runtimes keep around an IPv6 literal in .hostname.
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return !isBlockedIpLiteral(host);
}

/** True for an IP-literal host in a private, link-local or reserved range. Loopback and any
 *  non-literal hostname are allowed (return false). */
function isBlockedIpLiteral(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true; // malformed dotted-quad → reject
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8 ("this host")
    return false; // 127.0.0.0/8 loopback + public are allowed
  }
  if (host.includes(":")) {
    // IPv6 literal.
    if (host === "::1") return false; // loopback allowed (parity with localhost)
    if (host === "::") return true; // unspecified
    const firstHextet = host.split(":")[0];
    if (firstHextet === "") return true; // "::<something>" non-loopback — block to be safe
    const h = parseInt(firstHextet, 16);
    if (Number.isNaN(h)) return false; // not a recognizable literal — treat as a hostname
    if (h >= 0xfc00 && h <= 0xfdff) return true; // fc00::/7 unique-local
    if (h >= 0xfe80 && h <= 0xfebf) return true; // fe80::/10 link-local
    return false;
  }
  return false; // plain hostname
}
