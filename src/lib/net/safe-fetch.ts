import { lookup } from "node:dns/promises";
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
