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
      assertSafeUrl("https://ok/y", { resolve: async () => ["8.8.8.8"] }),
    ).resolves.toBeUndefined();
  });
});

describe("safeFetch chokepoint", () => {
  it("runs the guard then fetches with redirect:error (the redirect-to-internal floor)", async () => {
    const calls: { url: unknown; init: RequestInit | undefined }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok");
    }) as typeof fetch;
    try {
      await safeFetch("https://ok/x", { method: "GET" }, { resolve: async () => ["8.8.8.8"] });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init?.redirect).toBe("error");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("refuses a private/metadata target without any outbound fetch", async () => {
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("");
    }) as typeof fetch;
    try {
      await expect(
        safeFetch("http://x/y", {}, { resolve: async () => ["169.254.169.254"] }),
      ).rejects.toBeInstanceOf(SsrfError);
      expect(called).toBe(false); // guard threw before any network egress
    } finally {
      globalThis.fetch = orig;
    }
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
