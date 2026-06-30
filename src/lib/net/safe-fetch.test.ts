import { describe, it, expect } from "vitest";
import { assertSafeUrl, SsrfError } from "./safe-fetch";
const PUBLIC = new Set(["public"] as const);
const WITH_PRIVATE = new Set(["public", "loopback", "private", "cgnat"] as const);
const r = (ips: string[]) => async () => ips;

describe("assertSafeUrl", () => {
  it("allows a public host (returns pinned public IP + hostname)", async () => {
    const out = await assertSafeUrl("https://hook.example.com/x", { allow: PUBLIC, resolve: r(["8.8.8.8"]) });
    expect(out).toEqual({ hostname: "hook.example.com", pinnedIp: "8.8.8.8" });
  });
  it("rejects non-http(s)", async () => {
    await expect(assertSafeUrl("ftp://x/y", { allow: PUBLIC, resolve: r(["8.8.8.8"]) })).rejects.toBeInstanceOf(SsrfError);
  });
  it("rejects when resolution returns nothing (fail-closed)", async () => {
    await expect(assertSafeUrl("https://x/y", { allow: PUBLIC, resolve: r([]) })).rejects.toBeInstanceOf(SsrfError);
  });
  it("blocks private by default policy", async () => {
    await expect(assertSafeUrl("https://x/y", { allow: PUBLIC, resolve: r(["10.0.0.5"]) })).rejects.toBeInstanceOf(SsrfError);
  });
  it("allows private under the with-private policy", async () => {
    const out = await assertSafeUrl("https://n8n.internal/y", { allow: WITH_PRIVATE, resolve: r(["192.168.1.9"]) });
    expect(out.pinnedIp).toBe("192.168.1.9");
  });
  it("ALWAYS blocks metadata/link-local even under with-private policy", async () => {
    await expect(assertSafeUrl("https://x/y", { allow: WITH_PRIVATE, resolve: r(["169.254.169.254"]) })).rejects.toBeInstanceOf(SsrfError);
  });
  it("rejects if ANY resolved IP violates (mixed public+private)", async () => {
    await expect(assertSafeUrl("https://x/y", { allow: PUBLIC, resolve: r(["8.8.8.8", "10.0.0.1"]) })).rejects.toBeInstanceOf(SsrfError);
  });
  it("normalizes obfuscated literals via the resolver (getaddrinfo returns canonical)", async () => {
    // resolver returns what getaddrinfo would for 0x7f000001 → 127.0.0.1 → loopback → blocked under PUBLIC
    await expect(assertSafeUrl("http://0x7f000001/y", { allow: PUBLIC, resolve: r(["127.0.0.1"]) })).rejects.toBeInstanceOf(SsrfError);
  });
});
