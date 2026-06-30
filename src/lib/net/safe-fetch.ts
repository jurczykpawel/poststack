import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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
export type Connector = (a: { url: string; pinnedIp: string; hostname: string; init: RequestInit }) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

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

/**
 * Default connector: connects pinned to `pinnedIp` (via a forced `lookup`) while keeping the
 * hostname for the `Host` header and TLS `servername` (cert validation stays on the hostname).
 * Rebinding-safe: the socket can never re-resolve the hostname. A 3xx is rejected, never followed
 * (`redirect: "error"` semantics). Honors `init.signal` and a hard timeout. Verified on Bun + Node
 * (Step-0 spike): both honor `lookup` (pins) and `servername` (cert validates on the hostname).
 */
export const pinnedConnect: Connector = ({ url, pinnedIp, hostname, init }) =>
  new Promise<Response>((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new SsrfError("invalid URL")); return; }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const family = pinnedIp.includes(":") ? 6 : 4;

    const headers = flattenHeaders(init);
    headers["host"] = hostname; // preserve hostname for routing / vhosts

    const signal = init.signal as AbortSignal | null | undefined;
    if (signal?.aborted) { reject(new SsrfError("request aborted")); return; }

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
          reject(new SsrfError(`refused redirect response (status ${status})`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(new Response(Buffer.concat(chunks), { status, statusText: res.statusMessage }));
        });
        res.on("error", reject);
      },
    );

    const onAbort = () => req.destroy(new SsrfError("request aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new SsrfError("request timed out")));
    req.on("error", (e) => reject(e));

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
  opts: { allow: ReadonlySet<IpCategory>; resolve?: Resolver; connect?: Connector },
): Promise<Response> {
  const { hostname, pinnedIp } = await assertSafeUrl(rawUrl, opts);
  return (opts.connect ?? pinnedConnect)({ url: rawUrl, pinnedIp, hostname, init });
}
