import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { classifyIp, type IpCategory } from "./ip-classify";

export class SsrfError extends Error {}
export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Categories no policy may ever allow — connecting here is never legitimate. */
const NEVER_ALLOWED: ReadonlySet<IpCategory> = new Set(["link_local", "unspecified", "multicast", "unknown"]);

export async function assertSafeUrl(
  rawUrl: string,
  opts: { allow: ReadonlySet<IpCategory>; resolve?: Resolver },
): Promise<{ hostname: string; pinnedIp: string }> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new SsrfError("invalid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SsrfError("unsupported protocol");
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const ips = await (opts.resolve ?? defaultResolver)(host);
  if (ips.length === 0) throw new SsrfError("could not resolve host");
  let pinned: string | null = null;
  for (const ip of ips) {
    const cat = classifyIp(ip);
    if (NEVER_ALLOWED.has(cat) || !opts.allow.has(cat)) {
      throw new SsrfError(`refused ${cat} address: ${ip}`); // reject if ANY resolved IP violates
    }
    if (pinned === null) pinned = ip;
  }
  return { hostname: host, pinnedIp: pinned! };
}

/** Connects a single request. Injectable so unit tests assert pinning without real sockets. */
export type Connector = (a: {
  url: string;
  pinnedIp: string;
  hostname: string;
  init: RequestInit;
  /** Hard wall-clock deadline in ms (testable seam; defaults to DEFAULT_DEADLINE_MS). */
  deadlineMs?: number;
  /** Response body cap in bytes (testable seam; defaults to MAX_RESPONSE_BYTES). Media ingest passes
   *  a far larger ceiling than the webhook default — its own readBodyCapped governs the real limit. */
  maxResponseBytes?: number;
  /** STREAMING mode (PSA52). When true the connector returns a Response whose body is the live
   *  response STREAM (no whole-body buffering, no `maxResponseBytes` cap, no hard wall-clock
   *  deadline) — the caller (readProviderBody) is the sole size + duration governor, while the
   *  socket inactivity timeout still bounds a hung connection. When falsy (webhook default) the body
   *  is buffered, capped at `maxResponseBytes`, and the hard deadline applies. */
  stream?: boolean;
}) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
/** Hard wall-clock ceiling: a request can NEVER outlive this, even under a slow drip (slowloris). */
const DEFAULT_DEADLINE_MS = 15_000;
/** Response body cap — webhook callers need only the status, so a tiny ceiling defeats memory-DoS. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Copy RequestInit.headers into a plain lowercase-keyed object. */
function flattenHeaders(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init.headers;
  if (!h) return out;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/** Hop-by-hop headers must not be forwarded onto a (web) Response built from a live stream — they
 *  describe THIS socket, not the message (and a forwarded `transfer-encoding`/`content-length` pair
 *  would contradict the streamed body). Everything else (incl. `content-length`, which the caller's
 *  cap precheck reads) is preserved. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate",
  "proxy-authorization", "te", "trailer",
]);

/** Copy a Node response's headers onto a web `Headers` for the streamed Response (skips hop-by-hop). */
function buildResponseHeaders(h: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) { for (const item of v) out.append(k, item); }
    else out.append(k, v);
  }
  return out;
}

/**
 * Default connector: connects pinned to `pinnedIp` (via a forced `lookup`) while keeping the
 * hostname for the `Host` header and TLS `servername` (cert validation stays on the hostname).
 * Rebinding-safe: the socket can never re-resolve the hostname. A 3xx is rejected, never followed
 * (`redirect: "error"` semantics). Honors `init.signal` and a hard timeout. Verified on Bun + Node
 * (Step-0 spike): both honor `lookup` (pins) and `servername` (cert validates on the hostname).
 */
export const pinnedConnect: Connector = ({ url, pinnedIp, hostname, init, deadlineMs, maxResponseBytes, stream }) =>
  new Promise<Response>((resolve, reject) => {
    const maxBytes = maxResponseBytes ?? MAX_RESPONSE_BYTES;
    let u: URL;
    try { u = new URL(url); } catch { reject(new SsrfError("invalid URL")); return; }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const family = pinnedIp.includes(":") ? 6 : 4;

    const headers = flattenHeaders(init);
    headers["host"] = hostname; // preserve hostname for routing / vhosts

    const signal = init.signal as AbortSignal | null | undefined;
    if (signal?.aborted) { reject(new SsrfError("request aborted")); return; }

    // Hard wall-clock deadline (independent of the inactivity timeout below): a slow-drip server
    // cannot keep the request alive past this. Cleared on any settle so the timer never leaks.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => { if (deadline) { clearTimeout(deadline); deadline = undefined; } };
    const settleResolve = (r: Response) => { clearDeadline(); resolve(r); };
    const settleReject = (e: unknown) => { clearDeadline(); reject(e); };

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname,
        port: Number(u.port) || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        servername: isHttps ? hostname : undefined, // TLS cert validates against the hostname
        // PIN: force the socket to the validated IP; honor the `all` flag (Bun/Node differ).
        lookup: ((
          _h: string,
          o: { all?: boolean },
          cb: (e: NodeJS.ErrnoException | null, addr: string | { address: string; family: number }[], fam: number) => void,
        ) => {
          if (o && o.all) cb(null, [{ address: pinnedIp, family }], family);
          else cb(null, pinnedIp, family);
        }) as unknown as http.RequestOptions["lookup"],
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          settleReject(new SsrfError(`refused redirect response (status ${status})`));
          return;
        }
        // STREAMING mode: hand the live response stream straight to the caller (no buffer, no
        // `maxResponseBytes` cap). The redirect guard above already ran, so we never stream a 3xx
        // body. `readBodyCapped` (caller) governs size; the inactivity timeout still bounds a hang.
        if (stream) {
          settleResolve(
            new Response(Readable.toWeb(res) as unknown as ReadableStream, {
              status,
              statusText: res.statusMessage,
              headers: buildResponseHeaders(res.headers),
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            // Memory-DoS guard: stop reading and tear down both ends immediately.
            res.destroy();
            req.destroy();
            settleReject(new SsrfError("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          settleResolve(new Response(Buffer.concat(chunks), { status, statusText: res.statusMessage }));
        });
        res.on("error", settleReject);
      },
    );

    const onAbort = () => req.destroy(new SsrfError("request aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    // Inactivity timeout (no bytes for N ms) — kept in BOTH modes so a stuck/hung socket is bounded
    // even when streaming a large download.
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new SsrfError("request timed out")));
    // Hard wall-clock deadline: applies ONLY to the buffered (webhook) path. In streaming mode it
    // would wrongly abort a legitimately slow/large download that is making steady progress, so it
    // is disabled there — the inactivity timeout above remains the safety bound.
    if (!stream) {
      deadline = setTimeout(() => {
        req.destroy();
        settleReject(new SsrfError("request deadline exceeded"));
      }, deadlineMs ?? DEFAULT_DEADLINE_MS);
    }
    req.on("error", (e) => settleReject(e));

    const body = init.body;
    if (body != null) {
      if (typeof body === "string") req.write(body);
      else if (body instanceof Uint8Array) req.write(Buffer.from(body));
      else req.write(String(body));
    }
    req.end();
  });

/**
 * SSRF-safe fetch. Validates the URL against the policy FIRST (so a violation throws BEFORE any
 * connection is attempted), then connects pinned to the validated IP. `connect` is injectable for
 * tests; the default is the rebinding-safe `pinnedConnect`.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  opts: {
    allow: ReadonlySet<IpCategory>;
    resolve?: Resolver;
    connect?: Connector;
    deadlineMs?: number;
    maxResponseBytes?: number;
    stream?: boolean;
  },
): Promise<Response> {
  const { hostname, pinnedIp } = await assertSafeUrl(rawUrl, opts);
  return (opts.connect ?? pinnedConnect)({
    url: rawUrl,
    pinnedIp,
    hostname,
    init,
    deadlineMs: opts.deadlineMs,
    maxResponseBytes: opts.maxResponseBytes,
    stream: opts.stream,
  });
}
