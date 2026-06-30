import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TelemetryEnvelope } from "./collect";

// Unit (no DB): sendTelemetry() claims atomically, then POSTs the envelope best-effort. We mock
// buildEnvelope and the claim/confirm helpers (so no real db is touched) and globalThis.fetch; the
// db is opaque (the claim is the sole gate). The claim/confirm DB semantics are covered by
// identity.integration.test.ts.

const ENVELOPE: TelemetryEnvelope = {
  schema_version: 1,
  project: "poststack",
  instance_id: "11111111-1111-1111-1111-111111111111",
  report_id: "22222222-2222-2222-2222-222222222222",
  sent_at: "2026-06-19T00:00:00.000Z",
  identity: { license_tier: null },
  // Minimal but real-enough shapes; the sender treats these as opaque JSON.
  deployment: {
    app_version: "1.0.0",
    runtime: "bun",
    runtime_version_major: "1",
    os: "linux",
    arch: "x64",
    cpu_bucket: "1",
    mem_bucket: "1-2",
    registration_enabled: false,
    history_retention_days: 60,
    platforms_enabled: [],
    integrations: { google: false, ai: false, storage: null },
  },
  metrics: {
    workspaces: 0,
    channels: { total: 0, by_platform: {}, needs_reauth: 0 },
    contacts: 0,
    conversations: 0,
    rules: 0,
    sequences: 0,
    webhooks_processed: { total: 0, last_24h: 0, by_status: {}, by_platform: {} },
    messages_sent: { total: 0, last_24h: 0, by_platform: {} },
    comments_replied: { total: 0, by_platform: {} },
    response_times: {
      window_days: 30,
      answer_rate_pct: 0,
      avg_first_response_ms: null,
      p50_bucket: null,
      p90_bucket: null,
      by_thread_type: {},
    },
  },
};

const CLAIM = { instanceId: ENVELOPE.instance_id, reportId: ENVELOPE.report_id };

const buildEnvelope = vi.fn(async (..._a: unknown[]) => ENVELOPE);
// claimSend resolves to a claim by default; tests override per-case (null = not due / lost race).
const claimSend = vi.fn(async (..._a: unknown[]) => CLAIM as { instanceId: string; reportId: string } | null);
const confirmSend = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("./collect", () => ({ buildEnvelope: (...a: unknown[]) => buildEnvelope(...a) }));
vi.mock("./identity", () => ({
  claimSend: (...a: unknown[]) => claimSend(...a),
  confirmSend: (...a: unknown[]) => confirmSend(...a),
}));

const REQUIRED = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_SECRET: "test-secret-at-least-32-characters-long",
  ENCRYPTION_KEY: "test-encryption-key-at-least-32-characters-long",
  APP_URL: "https://app.example.com",
  CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
  TELEMETRY_URL: "https://telemetry.example.com/v1/ingest",
};

const fakeDb = {} as never; // opaque: the claim/confirm helpers are mocked

async function loadSend(over: Record<string, string | undefined>) {
  vi.resetModules();
  Object.assign(process.env, REQUIRED, over);
  // Re-mock after resetModules (vi.mock hoists, but resetModules clears the registry).
  vi.doMock("./collect", () => ({ buildEnvelope: (...a: unknown[]) => buildEnvelope(...a) }));
  vi.doMock("./identity", () => ({
    claimSend: (...a: unknown[]) => claimSend(...a),
    confirmSend: (...a: unknown[]) => confirmSend(...a),
  }));
  return import("./send");
}

/** Read a fetch mock's first call as [url, init] with init typed for assertions. */
function firstFetchCall(mock: ReturnType<typeof vi.fn>): { url: unknown; init: RequestInit & { headers: Record<string, string> } } {
  const call = mock.mock.calls[0] as [unknown, RequestInit & { headers: Record<string, string> }] | undefined;
  if (!call) throw new Error("fetch was not called");
  return { url: call[0], init: call[1] };
}

const SAVED = { ...process.env };
beforeEach(() => {
  process.env = { ...SAVED };
  buildEnvelope.mockClear();
  claimSend.mockClear();
  claimSend.mockResolvedValue(CLAIM);
  confirmSend.mockClear();
  confirmSend.mockResolvedValue(undefined);
  vi.useRealTimers();
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sendTelemetry", () => {
  it("is a no-op when telemetry is disabled (no claim, no fetch, no build)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { sendTelemetry } = await loadSend({ POSTSTACK_TELEMETRY_DISABLED: "true" });

    await expect(sendTelemetry(fakeDb)).resolves.toBeUndefined();
    expect(claimSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildEnvelope).not.toHaveBeenCalled();
  });

  it("is a no-op for a non-deployment host (no claim, no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { sendTelemetry } = await loadSend({ APP_URL: "http://localhost:3000" });

    await expect(sendTelemetry(fakeDb)).resolves.toBeUndefined();
    expect(claimSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the claim is not granted (not due / lost race): no fetch, no confirm", async () => {
    claimSend.mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendTelemetry } = await loadSend({});

    await expect(sendTelemetry(fakeDb)).resolves.toBeUndefined();
    expect(claimSend).toHaveBeenCalledTimes(1);
    expect(buildEnvelope).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmSend).not.toHaveBeenCalled();
  });

  it("POSTs the envelope (built with the claimed report_id) and confirms on success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendTelemetry } = await loadSend({});

    await expect(sendTelemetry(fakeDb)).resolves.toBeUndefined();

    expect(buildEnvelope).toHaveBeenCalledWith(fakeDb, CLAIM.reportId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe(REQUIRED.TELEMETRY_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(init.body as string);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.project).toBe("poststack");
    expect(confirmSend).toHaveBeenCalledTimes(1);
  });

  it("retries once on a network error then confirms (single failure)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});

    const p = sendTelemetry(fakeDb);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirmSend).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives up after the retry on a persistent network error: no throw, one warn, NO confirm", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});

    const p = sendTelemetry(fakeDb);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirmSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats a non-2xx response as a failure: retries, no throw, NO confirm", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});

    const p = sendTelemetry(fakeDb);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirmSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not leak the payload contents into the warn log", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});

    const p = sendTelemetry(fakeDb);
    await vi.runAllTimersAsync();
    await p;

    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain(ENVELOPE.instance_id);
    expect(logged).not.toContain("schema_version");
  });
});

describe("sendTelemetryOnBoot", () => {
  it("does nothing (no log, no claim, no send) when telemetry is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({ POSTSTACK_TELEMETRY_DISABLED: "true" });

    await sendTelemetryOnBoot(fakeDb);

    expect(info).not.toHaveBeenCalled();
    expect(claimSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the enabled notice and fires a send (the atomic claim is the debounce)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});

    await sendTelemetryOnBoot(fakeDb);
    // The send is fire-and-forget; let the microtask/fetch settle.
    await new Promise((r) => setTimeout(r, 0));

    const logged = info.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Telemetry enabled");
    expect(logged).toContain("POSTSTACK_TELEMETRY_DISABLED=true");
    expect(claimSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch when the claim is not granted (debounced by the window)", async () => {
    claimSend.mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});

    await sendTelemetryOnBoot(fakeDb);
    await new Promise((r) => setTimeout(r, 0));

    expect(claimSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws even if the claim fails", async () => {
    claimSend.mockRejectedValue(new Error("db down"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});

    await expect(sendTelemetryOnBoot(fakeDb)).resolves.toBeUndefined();
  });
});

// TELEM-LOCALHOST1: local dev / CI / test runs (APP_URL on a localhost-ish host) must not phone home,
// or each fresh instance id inflates the public fleet's "active instances".
describe("isNonDeploymentHost", () => {
  it("suppresses localhost, loopback, wildcard, empty and *.local hosts", async () => {
    const { isNonDeploymentHost } = await loadSend({});
    for (const url of [
      undefined,
      "",
      "http://localhost:3000",
      "http://localhost",
      "http://127.0.0.1:3000",
      "http://0.0.0.0:8080",
      "https://app.localhost",
      "https://poststack.local",
    ]) {
      expect(isNonDeploymentHost(url)).toBe(true);
    }
  });

  it("allows a real deployment domain to report", async () => {
    const { isNonDeploymentHost } = await loadSend({});
    for (const url of [
      "https://poststack.techskills.academy",
      "https://poststack.tojest.dev",
      "https://social.example.com",
    ]) {
      expect(isNonDeploymentHost(url)).toBe(false);
    }
  });

  // TELEM-LOCALHOST1 completeness: the guard listed only the literal 127.0.0.1, so the rest of the
  // loopback range and any private/LAN/CGNAT/link-local IP-literal APP_URL still phoned home.
  it("suppresses the whole loopback range + private/LAN/CGNAT/link-local IP literals (not just 127.0.0.1)", async () => {
    const { isNonDeploymentHost } = await loadSend({});
    for (const url of [
      "http://127.0.0.5:3000",    // 127/8 loopback, not the literal .1
      "http://[::1]:3000",         // ipv6 loopback
      "http://10.0.0.5",           // 10/8 private
      "http://192.168.1.10:8080",  // 192.168/16 private LAN
      "http://172.16.4.4",         // 172.16/12 private
      "http://100.64.0.1",         // 100.64/10 CGNAT
      "http://169.254.169.254",    // link-local (cloud metadata)
    ]) {
      expect(isNonDeploymentHost(url)).toBe(true);
    }
  });

  it("still lets a genuine public IP-literal deployment report", async () => {
    const { isNonDeploymentHost } = await loadSend({});
    expect(isNonDeploymentHost("http://5.6.7.8:3000")).toBe(false);
  });
});
