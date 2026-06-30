/** Classify an IP literal into a routing/safety category. Fail-closed: anything not positively a
 *  public unicast address is a non-"public" category (and `unknown` for unparseable). Handles IPv4,
 *  IPv6, and IPv4-mapped IPv6 (`::ffff:…`). Single source of truth for every SSRF policy. */
export type IpCategory =
  | "public" | "loopback" | "private" | "cgnat"
  | "link_local" | "unspecified" | "multicast" | "unknown";

export function classifyIp(ip: string): IpCategory {
  const lower = ip.trim().toLowerCase();
  if (lower.includes(":")) return classifyV6(lower);
  return classifyV4(lower);
}

function classifyV4(ip: string): IpCategory {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return "unknown";
  const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  if (oct.some((o) => o > 255)) return "unknown";
  const [a, b] = oct;
  if (a === 0) return "unspecified";          // 0.0.0.0/8
  if (a === 127) return "loopback";           // 127.0.0.0/8
  if (a === 10) return "private";             // 10/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16/12
  if (a === 192 && b === 168) return "private";          // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";  // 100.64/10
  if (a === 169 && b === 254) return "link_local";       // 169.254/16 (incl. metadata)
  if (a >= 224 && a <= 239) return "multicast";          // 224.0.0.0/4
  if (a >= 240) return "unknown";             // 240/4 reserved + 255.255.255.255
  return "public";
}

function classifyV6(ip: string): IpCategory {
  // IPv4-mapped → reclassify as v4.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return classifyV4(mapped[1]!);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16), lo = parseInt(mappedHex[2]!, 16);
    return classifyV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (ip === "::") return "unspecified";
  if (ip === "::1") return "loopback";
  if (/^fe[89ab]/.test(ip)) return "link_local"; // fe80::/10
  if (/^f[cd]/.test(ip)) return "private";        // fc00::/7 ULA
  if (/^fe[c-f]/.test(ip)) return "private";      // fec0::/10 (deprecated site-local) → treat private
  if (/^ff/.test(ip)) return "multicast";         // ff00::/8
  if (/^[23][0-9a-f]{0,3}:/.test(ip)) return "public"; // 2000::/3 global unicast
  return "unknown";                               // fail-closed
}
