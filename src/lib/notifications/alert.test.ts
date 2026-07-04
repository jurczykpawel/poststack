import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Connector } from "@/lib/net/safe-fetch";

// SECURE-DEFAULT HARDENING (intended behavior change): alert delivery now goes through the shared
// secure-by-default webhook guard (assertSafeWebhookTarget + safeFetchWebhook). The guard RESOLVES
// DNS and blocks private/loopback targets BY DEFAULT (allowed only with WEBHOOK_ALLOW_PRIVATE_TARGETS),
// while metadata/link-local are ALWAYS blocked. The old guard (isSafeAlertWebhookUrl) was literal-IP
// only and permissive (allowed any hostname + loopback). The cases below assert the NEW policy as
// observed through dispatchAlert: private skipped by default, allowed with the flag, metadata always
// skipped — all best-effort (never throws).

// rateLimit is mocked so the throttle is deterministic without a DB.
const rateLimit = vi.fn();
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));

// No per-workspace webhook config here (its own integration test covers that) → these unit cases
// exercise the global env fallback path. Mocking it also keeps the DB out of this unit suite.
vi.mock("./alert-webhook", () => ({ getAlertWebhook: vi.fn().mockResolvedValue(null) }));

// CONFIG1: dispatchAlert reads CHANNEL_ALERT_WEBHOOK_URL via getConfig. Pure-unit test (no DB) →
// mock getConfig to read process.env, preserving the per-case env control below.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => process.env[key] ?? "",
}));

// vi.mock factories are hoisted above module top-level, so the mutable state they close over must
// live in vi.hoisted (which runs first) rather than plain top-level consts.
const { envState, resolverMap, connector, resolve } = vi.hoisted(() => {
  const envState = { WEBHOOK_ALLOW_PRIVATE_TARGETS: false };
  const resolverMap = new Map<string, string>();
  const connector = vi.fn<Connector>(async () => new Response("ok", { status: 200 }));
  const resolve = async (host: string): Promise<string[]> => {
    const ip = resolverMap.get(host);
    if (!ip) throw new Error(`unmapped host in test: ${host}`);
    return [ip];
  };
  return { envState, resolverMap, connector, resolve };
});

// The secure-default policy reads env.WEBHOOK_ALLOW_PRIVATE_TARGETS at call-time inside webhookAllow().
// A mutable mock object lets each case flip the flag without resetModules.
vi.mock("@/lib/env", () => ({ env: envState }));

// We keep the REAL guard (assertSafeWebhookTarget / webhookAllow / classifyIp) so dispatchAlert's
// skip-vs-deliver decision is driven by the actual policy — but inject a deterministic resolver
// (hostname → IP map) and a fake connector, so no real DNS/sockets are touched.
vi.mock("@/lib/webhooks/safe-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/safe-target")>();
  return {
    ...actual,
    safeFetchWebhook: (url: string, init: RequestInit = {}) =>
      actual.safeFetchWebhook(url, init, { resolve, connect: connector }),
  };
});

import { dispatchAlert } from "./alert";
import { getAlertWebhook } from "./alert-webhook";

beforeEach(() => {
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  envState.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
  resolverMap.clear();
  resolverMap.set("hooks.example", "93.184.216.34"); // public
  resolverMap.set("internal.example", "192.168.1.5"); // RFC1918 private
  resolverMap.set("metadata.example", "169.254.169.254"); // cloud metadata (link-local)
  rateLimit.mockResolvedValue({ allowed: true }); // not throttled by default
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchAlert", () => {
  it("POSTs the alert with its type discriminator to a public webhook", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";

    await dispatchAlert({ type: "delivery_failed", channelId: "ch-1", workspaceId: "ws-1", detail: "boom" });

    expect(connector).toHaveBeenCalledTimes(1);
    const arg = connector.mock.calls[0][0];
    expect(arg.url).toBe("https://hooks.example/alert");
    expect(arg.pinnedIp).toBe("93.184.216.34"); // pinned to the resolved public IP
    expect((arg.init.method ?? "").toUpperCase()).toBe("POST");
    const body = JSON.parse(arg.init.body as string);
    expect(body.type).toBe("delivery_failed");
    expect(body.channel_id).toBe("ch-1");
    expect(body.detail).toBe("boom");
  });

  it("renders a channel_reauth_urgent alert through the customized (mailstack) body — subject + days_left + expires_at", async () => {
    // Per-workspace path (mirrors prod: mailstack trusted-mode, subject/message from {{placeholders}}).
    vi.mocked(getAlertWebhook).mockResolvedValueOnce({
      url: "https://hooks.example/v1/send",
      enabled: true,
      headers: { Authorization: "Bearer secret" },
      fieldSelection: null,
      extraFields: {
        brand: "tsa",
        template: "contact",
        to: "op@example.com",
        subject: "[PostStack] {{type}} — {{display_name}}",
        message: "{{days_left}} day(s) left — reconnect before {{expires_at}}",
      },
    });

    await dispatchAlert({
      type: "channel_reauth_urgent",
      channelId: "ch-9",
      workspaceId: "ws-1",
      platform: "linkedin",
      displayName: "Paweł Jurczyk",
      detail: "Reconnect required before the access token expires.",
      expiresAt: "2026-08-12T13:00:00.000Z",
      daysLeft: 1,
    });

    expect(connector).toHaveBeenCalledTimes(1);
    const arg = connector.mock.calls[0][0];
    expect(arg.url).toBe("https://hooks.example/v1/send");
    expect((arg.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(arg.init.body as string);
    // standard fields still present + the urgent discriminator
    expect(body.type).toBe("channel_reauth_urgent");
    expect(body.platform).toBe("linkedin");
    expect(body.expires_at).toBe("2026-08-12T13:00:00.000Z");
    expect(body.days_left).toBe(1);
    // {{placeholder}} substitution into the mail subject/message + fixed recipient
    expect(body.subject).toBe("[PostStack] channel_reauth_urgent — Paweł Jurczyk");
    expect(body.message).toBe("1 day(s) left — reconnect before 2026-08-12T13:00:00.000Z");
    expect(body.to).toBe("op@example.com");
  });

  it("is a no-op when no webhook is configured", async () => {
    await dispatchAlert({ type: "event_error", detail: "x" });
    expect(connector).not.toHaveBeenCalled();
  });

  it("suppresses a duplicate (same type+channel) within the throttle window", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    // First passes (allowed), second is throttled (not allowed).
    rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });

    await dispatchAlert({ type: "delivery_failed", channelId: "ch-1" });
    await dispatchAlert({ type: "delivery_failed", channelId: "ch-1" });

    expect(connector).toHaveBeenCalledTimes(1);
    // the throttle key is scoped by type + channel.
    expect(rateLimit).toHaveBeenCalledWith("alert:delivery_failed:ch-1", 1, expect.any(Number));
  });

  it("never throws if the webhook call fails (best-effort)", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    connector.mockRejectedValueOnce(new Error("network down"));
    await expect(dispatchAlert({ type: "channel_reauth", channelId: "ch-1" })).resolves.toBeUndefined();
  });

  // --- secure-default policy, observed through dispatchAlert ---

  it("ALWAYS skips a cloud-metadata target (169.254.169.254), no throw", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "http://metadata.example/latest/meta-data/";
    await expect(dispatchAlert({ type: "event_error" })).resolves.toBeUndefined();
    expect(connector).not.toHaveBeenCalled();
  });

  it("skips a private (RFC1918) target by default, no throw", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "http://internal.example/hook";
    await expect(dispatchAlert({ type: "event_error" })).resolves.toBeUndefined();
    expect(connector).not.toHaveBeenCalled();
  });

  it("delivers to a private target when WEBHOOK_ALLOW_PRIVATE_TARGETS is set (self-host opt-in)", async () => {
    envState.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "http://internal.example/hook";
    await dispatchAlert({ type: "event_error" });
    expect(connector).toHaveBeenCalledTimes(1);
    expect(connector.mock.calls[0][0].pinnedIp).toBe("192.168.1.5");
  });

  it("STILL skips cloud-metadata even with WEBHOOK_ALLOW_PRIVATE_TARGETS (never-allowed category)", async () => {
    envState.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "http://metadata.example/latest/meta-data/";
    await expect(dispatchAlert({ type: "event_error" })).resolves.toBeUndefined();
    expect(connector).not.toHaveBeenCalled();
  });

  it("fails open (still alerts) when the throttle store errors", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    rateLimit.mockRejectedValue(new Error("db down"));
    await dispatchAlert({ type: "delivery_held", channelId: "ch-1" });
    expect(connector).toHaveBeenCalledTimes(1);
  });
});
