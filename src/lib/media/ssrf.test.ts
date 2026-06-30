import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isPrivateIp, assertSafeUrl, safeFetch, SsrfError } from "./ssrf";

describe("ssrf guard", () => {
  it("flags private/loopback/link-local/metadata IPs", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("172.16.5.5")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  it("fails CLOSED on IPv4-mapped IPv6, unspecified, invalid octets, and unparseable input", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true); // mapped loopback
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true); // mapped metadata
    expect(isPrivateIp("::ffff:7f00:0001")).toBe(true); // mapped loopback, hex tail
    expect(isPrivateIp("::")).toBe(true); // unspecified
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("999.1.1.1")).toBe(true); // invalid octet → unsafe, not fail-open
    expect(isPrivateIp("not-an-ip")).toBe(true); // unparseable → unsafe
    expect(isPrivateIp("fe80::1")).toBe(true); // link-local
    expect(isPrivateIp("fc00::1")).toBe(true); // unique-local
    expect(isPrivateIp("fd12:3456::1")).toBe(true);
    expect(isPrivateIp("fec0::1")).toBe(true); // site-local
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
    expect(isPrivateIp("224.0.0.1")).toBe(true); // v4 multicast
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false); // genuine public v6 still passes
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });

  it("rejects non-http(s) and private resolution, allows public", async () => {
    await expect(
      assertSafeUrl("ftp://example.com/x", { resolve: async () => ["8.8.8.8"] }),
    ).rejects.toThrow();
    await expect(
      assertSafeUrl("http://x/y", { resolve: async () => ["10.0.0.1"] }),
    ).rejects.toThrow();
    await expect(
      assertSafeUrl("http://x/y", { resolve: async () => ["127.0.0.1"] }),
    ).rejects.toBeInstanceOf(SsrfError); // loopback
    await expect(
      assertSafeUrl("http://x/y", { resolve: async () => ["169.254.169.254"] }),
    ).rejects.toBeInstanceOf(SsrfError); // cloud metadata
    await expect(
      assertSafeUrl("https://ok/y", { resolve: async () => ["8.8.8.8"] }),
    ).resolves.toBeUndefined();
  });
});

describe("safeFetch chokepoint (delegates to the shared rebinding-safe pinned core)", () => {
  // Media now connects over the net core's node:http(s) pinned connector (NOT global fetch). We keep
  // the REAL policy (resolve → classify → pin) and inject the transport seam (`connect`) so the test
  // asserts pinning without opening a socket — mock only the transport, keep the real policy.
  it("PINS: passes the validated public IP + hostname to the connector after the guard", async () => {
    const seen: { url: string; pinnedIp: string; hostname: string; init: RequestInit }[] = [];
    const connect = async (a: { url: string; pinnedIp: string; hostname: string; init: RequestInit }) => {
      seen.push(a);
      return new Response("ok", { status: 200 });
    };
    const res = await safeFetch(
      "https://cdn.example.com/x.mp4",
      { method: "GET" },
      { resolve: async () => ["8.8.8.8"], connect },
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pinnedIp).toBe("8.8.8.8"); // connect-time IP pinning — the rebind window is closed
    expect(seen[0]!.hostname).toBe("cdn.example.com");
  });

  it("refuses a private/metadata target BEFORE connecting (SsrfError, connector never reached)", async () => {
    let called = false;
    const connect = async () => {
      called = true;
      return new Response("");
    };
    await expect(
      safeFetch("http://x/y", {}, { resolve: async () => ["169.254.169.254"], connect }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(called).toBe(false); // guard threw before any network egress

    // public-only policy: a plain private (RFC1918) target is refused just the same.
    await expect(
      safeFetch("http://x/y", {}, { resolve: async () => ["10.0.0.5"], connect }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(called).toBe(false);
  });
});

describe("PSA1 class guard — caller-influenced URL fetches route through safeFetch", () => {
  // Pins the confirmed instances so the class can't regrow: the raw user-URL identifiers must never
  // be passed to a bare fetch() again — they go through the guarded chokepoint. (Platform-returned
  // upload URLs — sj.upload_url / location / uploadUrl — are NOT caller-influenced and are excluded.)
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  // NOTE (UNIFY1 Phase 1): the webhook-dispatch assertion is RE-ADDED when src/lib/webhooks/dispatch.ts
  // lands. The publish providers are ported, so their caller-URL fetches are pinned here.
  it("no bare fetch() of a known user-URL remains in media + providers; all use safeFetch", () => {
    const meta = read("../providers/meta.ts");
    const youtube = read("../providers/youtube.ts");
    const tiktok = read("../providers/tiktok.ts");
    const service = read("./service.ts");

    expect(meta).not.toMatch(/[^e]fetch\(coverUrl/);
    expect(youtube).not.toMatch(/[^e]fetch\(coverUrl/);
    expect(youtube).not.toMatch(/[^e]fetch\(videoUrl/);
    expect(tiktok).not.toMatch(/[^e]fetch\(videoUrl/);
    expect(service).not.toMatch(/[^e]fetch\(url\)/);

    expect(meta).toContain("safeFetch(coverUrl)");
    expect(youtube).toContain("safeFetch(coverUrl)");
    expect(youtube).toContain("safeFetch(videoUrl)");
    expect(tiktok).toContain("safeFetch(videoUrl)");
    expect(service).toContain("safeFetch(url");
  });
});
