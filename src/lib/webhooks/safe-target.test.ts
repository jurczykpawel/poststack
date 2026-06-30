import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Resolver } from "@/lib/net/safe-fetch";
import type { IpCategory } from "@/lib/net/ip-classify";

// The webhook policy reads a single resolved boolean (env.WEBHOOK_ALLOW_PRIVATE_TARGETS). To exercise
// both states we mock @/lib/env per-describe and re-import safe-target after resetModules, so each
// block loads a module bound to the intended flag value.

async function loadWithFlag(flag: boolean) {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({ env: { WEBHOOK_ALLOW_PRIVATE_TARGETS: flag } }));
  return import("./safe-target");
}

const resolverTo = (ip: string): Resolver => async () => [ip];

describe("webhookAllow — flag OFF (secure-by-default)", () => {
  let webhookAllow: () => ReadonlySet<IpCategory>;
  let assertSafeWebhookTarget: (typeof import("./safe-target"))["assertSafeWebhookTarget"];

  beforeEach(async () => {
    ({ webhookAllow, assertSafeWebhookTarget } = await loadWithFlag(false));
  });

  it("allows public only", () => {
    expect([...webhookAllow()]).toEqual(["public"]);
  });

  it("rejects a private (192.168.x) target", async () => {
    await expect(
      assertSafeWebhookTarget("http://internal.example.com/hook", { resolve: resolverTo("192.168.1.5") }),
    ).rejects.toThrow(/refused/);
  });

  it("rejects cloud-metadata (169.254.169.254)", async () => {
    await expect(
      assertSafeWebhookTarget("http://metadata.example.com/hook", { resolve: resolverTo("169.254.169.254") }),
    ).rejects.toThrow(/refused/);
  });

  it("resolves a public target", async () => {
    await expect(
      assertSafeWebhookTarget("https://hooks.example.com/x", { resolve: resolverTo("93.184.216.34") }),
    ).resolves.toMatchObject({ pinnedIp: "93.184.216.34" });
  });
});

describe("webhookAllow — flag ON (self-host opt-in)", () => {
  let webhookAllow: () => ReadonlySet<IpCategory>;
  let assertSafeWebhookTarget: (typeof import("./safe-target"))["assertSafeWebhookTarget"];

  beforeEach(async () => {
    ({ webhookAllow, assertSafeWebhookTarget } = await loadWithFlag(true));
  });

  it("includes public+loopback+private+cgnat", () => {
    const a = webhookAllow();
    for (const c of ["public", "loopback", "private", "cgnat"] as const) expect(a.has(c)).toBe(true);
  });

  it("NEVER includes link_local/unspecified/multicast/unknown", () => {
    const a = webhookAllow();
    for (const c of ["link_local", "unspecified", "multicast", "unknown"] as const) expect(a.has(c)).toBe(false);
  });

  it("now resolves a private (192.168.x) target", async () => {
    await expect(
      assertSafeWebhookTarget("http://internal.example.com/hook", { resolve: resolverTo("192.168.1.5") }),
    ).resolves.toMatchObject({ pinnedIp: "192.168.1.5" });
  });

  it("STILL rejects cloud-metadata (169.254.169.254) — blocked by the core regardless of flag", async () => {
    await expect(
      assertSafeWebhookTarget("http://metadata.example.com/hook", { resolve: resolverTo("169.254.169.254") }),
    ).rejects.toThrow(/refused/);
  });
});
