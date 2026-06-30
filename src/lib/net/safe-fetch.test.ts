import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertSafeUrl, safeFetch, SsrfError } from "./safe-fetch";
const PUBLIC = new Set(["public"] as const);
const WITH_PRIVATE = new Set(["public", "loopback", "private", "cgnat"] as const);
const LOOPBACK = new Set(["loopback"] as const);
const r = (ips: string[]) => async () => ips;

/** Spin up a localhost http server for the test; returns its url + a close fn. */
async function withServer(
  handler: http.RequestListener,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

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

describe("safeFetch", () => {
  it("safeFetch passes the validated pinned IP + hostname to the connector", async () => {
    let seen: { pinnedIp: string; hostname: string } | null = null;
    const connect = async (a: { pinnedIp: string; hostname: string }) => {
      seen = { pinnedIp: a.pinnedIp, hostname: a.hostname };
      return new Response("ok", { status: 200 });
    };
    const res = await safeFetch(
      "https://hook.example.com/x",
      { method: "POST", body: "{}" },
      { allow: PUBLIC, resolve: async () => ["8.8.8.8"], connect },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ pinnedIp: "8.8.8.8", hostname: "hook.example.com" });
  });

  it("safeFetch refuses before connecting when policy is violated", async () => {
    let called = false;
    const connect = async () => {
      called = true;
      return new Response("");
    };
    await expect(
      safeFetch("https://x/y", {}, { allow: PUBLIC, resolve: async () => ["10.0.0.1"], connect }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(called).toBe(false);
  });

  // Integration-style: exercises the REAL default pinnedConnect against a public https host.
  // Gated behind network egress — if the runner forbids egress, the connection-level error is
  // tolerated (the Step-0 spike covered the real pinned path deterministically).
  it("real safeFetch reaches a public https host (network-gated)", async () => {
    let res: Response;
    try {
      res = await safeFetch("https://example.com/", { method: "GET" }, { allow: PUBLIC });
    } catch (e) {
      if (e instanceof SsrfError) throw e; // a policy/redirect bug must still fail the test
      console.warn("network egress unavailable, skipping real-fetch assertion:", (e as Error).message);
      return;
    }
    expect([200]).toContain(res.status);
  }, 20000);

  it("real safeFetch rejects a private-resolving host (no network)", async () => {
    await expect(
      safeFetch("https://internal.example/", { method: "GET" }, { allow: PUBLIC, resolve: async () => ["10.1.2.3"] }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("pinnedConnect hardening (default connector, local server)", () => {
  it("rejects an oversized response body (> MAX_RESPONSE_BYTES)", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        // Stream ~2 MB in chunks; the cap (1 MB) must abort before we finish.
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 2_000_000) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
      },
      async (url) => {
        await expect(
          safeFetch(url, { method: "GET" }, { allow: LOOPBACK, resolve: r(["127.0.0.1"]) }),
        ).rejects.toThrow(/response too large/);
      },
    );
  }, 20000);

  it("resolves a small (< cap) response body", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
      async (url) => {
        const res = await safeFetch(url, { method: "GET" }, { allow: LOOPBACK, resolve: r(["127.0.0.1"]) });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      },
    );
  }, 20000);

  it("enforces a hard wall-clock deadline against a never-responding server", async () => {
    await withServer(
      () => {
        /* never respond: accept the socket but send nothing */
      },
      async (url) => {
        const started = Date.now();
        await expect(
          safeFetch(url, { method: "GET" }, { allow: LOOPBACK, resolve: r(["127.0.0.1"]), deadlineMs: 50 }),
        ).rejects.toThrow(/deadline exceeded/);
        expect(Date.now() - started).toBeLessThan(5_000);
      },
    );
  }, 20000);
});
