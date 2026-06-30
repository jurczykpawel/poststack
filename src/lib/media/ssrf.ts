import { lookup } from "node:dns/promises";
import { classifyIp } from "@/lib/net/ip-classify";

/** Raised when a URL is rejected by the SSRF guard — lets callers map it to a 400 (not a leaked 500). */
export class SsrfError extends Error {}

/**
 * Classify an IP literal as private/internal/unroutable. Delegates to the shared `classifyIp`
 * (single source of truth) — media's policy is to block **every** non-public category, so this is
 * `true` for anything that isn't positively a public unicast address. **Fail-closed:** unparseable
 * input classifies as `unknown` (non-public) and is treated as unsafe. Handles IPv4-mapped IPv6
 * (`::ffff:…`), IPv6 link-local/ULA/multicast, CGNAT, loopback, and cloud metadata (169.254.169.254).
 */
export function isPrivateIp(ip: string): boolean {
  return classifyIp(ip) !== "public";
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
