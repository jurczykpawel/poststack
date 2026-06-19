import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TelemetryEnvelope } from "./collect";

// Unit (no DB): sendTelemetry() POSTs the envelope best-effort. We mock buildEnvelope (so no real
// db is touched) and globalThis.fetch, and pass a thin fake db whose update() we can assert against.

const ENVELOPE: TelemetryEnvelope = {
  schema_version: 1,
  project: "poststack",
  instance_id: "11111111-1111-1111-1111-111111111111",
  sent_at: "2026-06-19T00:00:00.000Z",
  identity: { domain_hash: "dh", license_hash: null, license_tier: null },
  // Minimal but real-enough shapes; the sender treats these as opaque JSON.
  deployment: {
    app_version: "1.0.0",
    runtime: "bun",
    runtime_version: "1.0.0",
    os: "linux",
    arch: "x64",
    cpu_count: 1,
    mem_total_mb: 1024,
    node_env: "test",
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
    webhooks_processed: { total: 0, last_24h: 0, by_status: {} },
    messages_sent: { total: 0, last_24h: 0 },
    comments_replied: { total: 0 },
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

const buildEnvelope = vi.fn(async (..._a: unknown[]) => ENVELOPE);
vi.mock("./collect", () => ({ buildEnvelope: (...a: unknown[]) => buildEnvelope(...a) }));

const REQUIRED = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_SECRET: "test-secret-at-least-32-characters-long",
  ENCRYPTION_KEY: "test-encryption-key-at-least-32-characters-long",
  APP_URL: "https://app.example.com",
  CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
  TELEMETRY_URL: "https://telemetry.example.com/v1/ingest",
};

/**
 * A fake db whose update().set().where() chain records the values it was asked to write, and whose
 * query.telemetryState.findFirst() returns a configurable singleton row (for the boot debounce).
 */
function fakeDb(row: { last_sent_at: Date | null } | null = null) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    query: {
      telemetryState: { findFirst: vi.fn(async () => row ?? undefined) },
    },
  };
  return { db, updateCalls };
}

async function loadSend(over: Record<string, string | undefined>) {
  vi.resetModules();
  Object.assign(process.env, REQUIRED, over);
  vi.doMock("./collect", () => ({ buildEnvelope: (...a: unknown[]) => buildEnvelope(...a) }));
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
  vi.useRealTimers();
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sendTelemetry", () => {
  it("is a no-op when telemetry is disabled (no fetch, no throw, no build)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { sendTelemetry } = await loadSend({ POSTSTACK_TELEMETRY_DISABLED: "true" });
    const { db } = fakeDb();

    await expect(sendTelemetry(db as never)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildEnvelope).not.toHaveBeenCalled();
  });

  it("POSTs a JSON envelope and records last_sent_at on success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendTelemetry } = await loadSend({});
    const { db, updateCalls } = fakeDb();

    await expect(sendTelemetry(db as never)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe(REQUIRED.TELEMETRY_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(init.body as string);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.project).toBe("poststack");

    // last_sent_at write attempted exactly once with a Date.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.last_sent_at).toBeInstanceOf(Date);
  });

  it("retries once on a network error then resolves without throwing (single failure)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});
    const { db, updateCalls } = fakeDb();

    const p = sendTelemetry(db as never);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First attempt failed, retry succeeded → state written, no warning.
    expect(updateCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives up after the retry on a persistent network error (no throw, one warn, no state write)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});
    const { db, updateCalls } = fakeDb();

    const p = sendTelemetry(db as never);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats a non-2xx response as a failure: retries, no throw, no state write", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});
    const { db, updateCalls } = fakeDb();

    const p = sendTelemetry(db as never);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not leak the payload contents into the warn log", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetry } = await loadSend({});
    const { db } = fakeDb();

    const p = sendTelemetry(db as never);
    await vi.runAllTimersAsync();
    await p;

    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain(ENVELOPE.instance_id);
    expect(logged).not.toContain("schema_version");
  });
});

describe("sendTelemetryOnBoot", () => {
  it("does nothing (no log, no read, no send) when telemetry is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({ POSTSTACK_TELEMETRY_DISABLED: "true" });
    const { db } = fakeDb();

    await sendTelemetryOnBoot(db as never);

    expect(info).not.toHaveBeenCalled();
    expect(db.query.telemetryState.findFirst).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the enabled notice and fires a send when last_sent_at is null", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});
    const { db } = fakeDb({ last_sent_at: null });

    await sendTelemetryOnBoot(db as never);
    // The send is fire-and-forget; let the microtask/fetch settle.
    await new Promise((r) => setTimeout(r, 0));

    const logged = info.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Telemetry enabled");
    expect(logged).toContain("POSTSTACK_TELEMETRY_DISABLED=true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs the notice but does NOT send when last_sent_at is recent (within the debounce window)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});
    const { db } = fakeDb({ last_sent_at: new Date(Date.now() - 60 * 60 * 1000) }); // 1h ago

    await sendTelemetryOnBoot(db as never);
    await new Promise((r) => setTimeout(r, 0));

    const logged = info.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Telemetry enabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends when last_sent_at is older than the debounce window", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});
    const { db } = fakeDb({ last_sent_at: new Date(Date.now() - 30 * 60 * 60 * 1000) }); // 30h ago

    await sendTelemetryOnBoot(db as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never throws even if the state read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendTelemetryOnBoot } = await loadSend({});
    const { db } = fakeDb({ last_sent_at: null });
    db.query.telemetryState.findFirst = vi.fn(async () => {
      throw new Error("db down");
    });

    await expect(sendTelemetryOnBoot(db as never)).resolves.toBeUndefined();
  });
});
