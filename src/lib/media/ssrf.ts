import { lookup } from "node:dns/promises";

/** Raised when a URL is rejected by the SSRF guard — lets callers map it to a 400 (not a leaked 500). */
export class SsrfError extends Error {}

/**
 * Classify an IP literal as private/internal/unroutable. **Fail-closed:** anything we cannot
 * positively classify as a public address is treated as unsafe (the old version returned `false` —
 * "public" — for unparseable input, a fail-OPEN bypass). Handles IPv4-mapped IPv6 (`::ffff:…`),
 * rejects `::`, range-checks octets, and covers fe80::/10, fc00::/7, fec0::/10, multicast.
 */
export function isPrivateIp(ip: string): boolean {
  const lower = ip.trim().toLowerCase();

  if (lower.includes(":")) {
    // IPv4-mapped IPv6 — re-check as IPv4 (dotted or hex tail).
    const mappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isPrivateIp(mappedDotted[1]!);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPrivateIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    if (lower === "::" || lower === "::1") return true; // unspecified / loopback
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(lower)) return true; // unique-local fc00::/7
    if (/^fe[c-f]/.test(lower)) return true; // site-local fec0::/10 (deprecated)
    if (/^ff/.test(lower)) return true; // multicast ff00::/8
    // Global unicast is 2000::/3 (first hex digit 2 or 3). Anything else → fail-closed unsafe.
    return !/^[23][0-9a-f]{0,3}:/.test(lower);
  }

  const m = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true; // not a parseable IPv4 → fail-closed unsafe
  const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (oct.some((o) => o > 255)) return true; // invalid octet (e.g. 999.1.1.1) → unsafe
  const [a, b] = oct as [number, number, number, number];
  if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved 224.0.0.0+ → unsafe
  return false;
}

type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

/** Throws `SsrfError` if the URL is not http(s) or resolves to a private/loopback/link-local/metadata address. */
export async function assertSafeUrl(raw: string, opts: { resolve?: Resolver } = {}): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SsrfError("unsupported protocol");
  const ips = await (opts.resolve ?? defaultResolver)(u.hostname);
  if (ips.length === 0) throw new SsrfError("could not resolve host");
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw new SsrfError(`refused private/internal address: ${ip}`);
  }
}

/**
 * The single chokepoint for every server-side fetch of a **caller-influenced** URL (media ingest,
 * webhook delivery, provider cover/thumbnail + media download). Runs the SSRF guard, then fetches
 * with `redirect: "error"` so a 3xx can't bounce the request to an internal target after the check.
 *
 * Residual risk (documented, accepted for now): a DNS-rebind between the guard's lookup and fetch's
 * own connect is NOT closed — that needs connect-time IP pinning (undici custom lookup), deferred
 * because pinning the socket to the resolved IP breaks TLS SNI/cert validation for https targets.
 * `redirect: "error"` closes the redirect-to-internal vector, which is the practical floor.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: { resolve?: Resolver } = {},
): Promise<Response> {
  await assertSafeUrl(url, opts);
  return fetch(url, { ...init, redirect: "error" });
}
