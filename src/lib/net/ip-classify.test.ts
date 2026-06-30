import { describe, it, expect } from "vitest";
import { classifyIp } from "./ip-classify";
import { isPrivateIp } from "@/lib/media/ssrf"; // current behavior to preserve

describe("classifyIp", () => {
  const cases: [string, ReturnType<typeof classifyIp>][] = [
    ["8.8.8.8", "public"], ["1.1.1.1", "public"],
    ["127.0.0.1", "loopback"], ["0.0.0.0", "unspecified"],
    ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"],
    ["172.32.0.1", "public"], ["192.168.1.1", "private"],
    ["100.64.0.1", "cgnat"], ["100.127.255.255", "cgnat"], ["100.128.0.1", "public"],
    ["169.254.169.254", "link_local"], ["169.254.0.1", "link_local"],
    ["224.0.0.1", "multicast"], ["239.255.255.255", "multicast"], ["255.255.255.255", "unknown"],
    ["::1", "loopback"], ["::", "unspecified"],
    ["fe80::1", "link_local"], ["fc00::1", "private"], ["fd12::1", "private"],
    ["ff02::1", "multicast"], ["2606:4700::1111", "public"],
    ["::ffff:10.0.0.1", "private"], ["::ffff:8.8.8.8", "public"], ["::ffff:127.0.0.1", "loopback"],
    ["999.1.1.1", "unknown"], ["not-an-ip", "unknown"], ["", "unknown"], ["0x7f000001", "unknown"],
  ];
  it.each(cases)("classifies %s as %s", (ip, cat) => { expect(classifyIp(ip)).toBe(cat); });

  // PARITY: the new classifier must agree with current media on "is this non-public".
  it("matches current media isPrivateIp for every battery IP (green on current HEAD)", () => {
    for (const [ip] of cases) {
      expect(classifyIp(ip) !== "public").toBe(isPrivateIp(ip));
    }
  });
});
