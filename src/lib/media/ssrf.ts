import { classifyIp, type IpCategory } from "@/lib/net/ip-classify";
import {
  assertSafeUrl as netAssertSafeUrl,
  safeFetch as netSafeFetch,
  type Connector,
  type Resolver,
} from "@/lib/net/safe-fetch";

// ONE SsrfError class across the whole app: re-export the net core's so that every `instanceof
// SsrfError` (media callers AND the net core) refers to the same constructor. Media callers map it to
// a 400 (see media/service.ts) — re-exporting (not redefining) keeps that catch working.
export { SsrfError } from "@/lib/net/safe-fetch";

/** Media's SSRF policy: only positively-public unicast targets. Every non-public category
 *  (loopback/private/cgnat/link-local/metadata/unspecified/multicast/unknown) is refused. */
const PUBLIC_ONLY = new Set<IpCategory>(["public"]);

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

/**
 * Throws `SsrfError` if the URL is not http(s) or resolves to any non-public address. Delegates to
 * the shared net core with media's public-only policy — same single source of truth that resolves
 * DNS, classifies, and (in safeFetch) pins the connection to the validated IP.
 */
export async function assertSafeUrl(raw: string, opts: { resolve?: Resolver } = {}): Promise<void> {
  await netAssertSafeUrl(raw, { allow: PUBLIC_ONLY, resolve: opts.resolve });
}

/**
 * The single chokepoint for every server-side fetch of a **caller-influenced** media URL (media
 * ingest, provider cover/thumbnail + media download, story thumbnail). Routes through the shared
 * rebinding-safe pinned core: resolve → classify (public-only) → **pin the validated IP** at
 * connect-time (TLS SNI preserved) → reject 3xx → STREAM the body. The DNS-rebind window the old
 * plain-`fetch` path left open is now CLOSED — the socket can never re-resolve to an internal target
 * after the guard.
 *
 * STREAMING (PSA52): media uses `stream: true`, so the body is delivered as a live stream — the
 * connector neither buffers the whole (possibly multi-hundred-MB) video into RAM nor imposes the
 * webhook's hard wall-clock deadline (a large download making steady progress must run past 15s).
 * `readProviderBody`/`readProviderCover` (providers/download.ts) are the SOLE size governors; the
 * socket inactivity timeout still bounds a hung connection.
 *
 * `connect` is an optional transport seam (tests inject it to assert pinning / mock the socket without
 * real egress); production uses the net core's default rebinding-safe `pinnedConnect`.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: { resolve?: Resolver; connect?: Connector } = {},
): Promise<Response> {
  return netSafeFetch(url, init, {
    allow: PUBLIC_ONLY,
    resolve: opts.resolve,
    connect: opts.connect,
    stream: true,
  });
}
