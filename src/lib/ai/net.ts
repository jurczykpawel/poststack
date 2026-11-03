import { classifyIp, type IpCategory } from "@/lib/net/ip-classify";
import { safeFetch, defaultResolver, type Connector, type Resolver } from "@/lib/net/safe-fetch";

// AIPROVIDER1: every call to an AI provider goes through here. Public addresses are always allowed;
// loopback / private / CGNAT only for targets the operator lists in AI_ALLOWED_PRIVATE_TARGETS
// (host, IP or IPv4 CIDR, optional :port). Link-local (cloud metadata) is refused by safeFetch even if listed.

export type AllowedTarget = { host: string; port?: number } | { cidr: { base: number; bits: number } };

const ipv4ToInt = (ip: string): number | null => {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m && m.slice(1).every((o) => Number(o) <= 255) ? ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0 : null;
};

/** Parse `AI_ALLOWED_PRIVATE_TARGETS`: comma-separated `host`, `ip`, `ip/bits`, each with an optional `:port` (`[::1]:11434` for IPv6). */
export function parseAllowedTargets(raw: string): AllowedTarget[] {
  const out: AllowedTarget[] = [];
  for (const item of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const cidr = item.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
    if (cidr) {
      const base = ipv4ToInt(cidr[1]!), bits = Number(cidr[2]);
      if (base !== null && bits <= 32) out.push({ cidr: { base, bits } });
      continue;
    }
    const m = item.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? item.match(/^([^:]+)(?::(\d+))?$/);
    if (m) out.push(m[2] ? { host: m[1]!, port: Number(m[2]) } : { host: m[1]! });
  }
  return out;
}

function matches(t: AllowedTarget, host: string, ip: string, port: number): boolean {
  if ("cidr" in t) {
    const n = ipv4ToInt(ip);
    const mask = t.cidr.bits === 0 ? 0 : (~0 << (32 - t.cidr.bits)) >>> 0;
    return n !== null && ((n & mask) >>> 0) === ((t.cidr.base & mask) >>> 0);
  }
  return (t.host === host || t.host === ip) && (t.port === undefined || t.port === port);
}

/** Hint for the operator when a target is refused. */
export const blockedTargetHint = (host: string) =>
  `Private and loopback addresses are blocked. To allow ${host}, add it to AI_ALLOWED_PRIVATE_TARGETS (e.g. ${host}:11434) on the server.`;

export async function aiFetch(
  url: string,
  init: RequestInit,
  opts: { allowed?: string; resolve?: Resolver; connect?: Connector; deadlineMs?: number; maxResponseBytes?: number } = {},
): Promise<Response> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const ips = await (opts.resolve ?? defaultResolver)(host);
  const targets = parseAllowedTargets(opts.allowed ?? process.env.AI_ALLOWED_PRIVATE_TARGETS ?? "");
  const allow = new Set<IpCategory>(["public"]);
  for (const ip of ips) if (targets.some((t) => matches(t, host, ip, port))) allow.add(classifyIp(ip));
  return safeFetch(url, init, { allow, resolve: async () => ips, connect: opts.connect, deadlineMs: opts.deadlineMs, maxResponseBytes: opts.maxResponseBytes });
}
