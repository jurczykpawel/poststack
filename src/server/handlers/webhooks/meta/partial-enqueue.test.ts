import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "crypto";

const APP_SECRET = "partial-enqueue-secret";

// addJob is driven per-test; rateLimit + the webhook_events log + channel resolution are stubbed so
// the handler needs no DB and the enqueue path is what's under test.
const addJob = vi.fn();
vi.mock("@/lib/queue/client", () => ({
  addJob: (...args: unknown[]) => addJob(...args),
  closeQueue: vi.fn(),
}));
vi.mock("@/lib/api/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
// logEvent reports every event as newly created so the handler proceeds to enqueue; markEventStatus
// is a no-op. (The full log behavior is covered by the smoke integration test against real Postgres.)
vi.mock("@/lib/idempotency", () => ({
  logEvent: vi.fn().mockResolvedValue({ created: true }),
  markEventStatus: vi.fn().mockResolvedValue(undefined),
}));
// db is touched only by resolveChannels (page→channel), which swallows errors → channel_id null.
vi.mock("@/lib/db", () => ({
  db: { query: { channels: { findMany: vi.fn().mockResolvedValue([]) } } },
}));

let POST: typeof import("./route").POST;

beforeAll(async () => {
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5433/test";
  ({ POST } = await import("./route"));
});

function signed(body: string) {
  const sig = `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;
  return new Request("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
    body,
  });
}

const twoMessages = JSON.stringify({
  object: "page",
  entry: [
    {
      id: "PAGE-1",
      messaging: [
        { sender: { id: "A" }, recipient: { id: "PAGE-1" }, timestamp: 1_770_000_000_000, message: { mid: "m1", text: "hi" } },
        { sender: { id: "B" }, recipient: { id: "PAGE-1" }, timestamp: 1_770_000_000_001, message: { mid: "m2", text: "yo" } },
      ],
    },
  ],
});

describe("meta webhook partial enqueue", () => {
  it("returns 503 when some events enqueue and others fail, so Meta retries the whole batch", async () => {
    // First event enqueues, second fails — a partial failure. Jobs are keyed and
    // idempotent, so re-delivering the successful one on retry is harmless; losing
    // the failed one is not. The handler must signal a retry.
    addJob.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("queue down"));
    const res = await POST(signed(twoMessages));
    expect(res.status).toBe(503);
  });

  it("returns 200 when every event enqueues", async () => {
    addJob.mockResolvedValue(undefined);
    const res = await POST(signed(twoMessages));
    expect(res.status).toBe(200);
  });

  it("re-enqueues an already-logged redelivery so a failed first enqueue never strands the event", async () => {
    // logEvent reports the row already exists (a redelivery whose ORIGINAL enqueue may have failed
    // → the job was never created). The handler must still enqueue; gating on `created` would leave
    // the event stuck in `received` forever. Re-enqueue is safe (jobKey dedups, worker CAS fires once).
    const idem = await import("@/lib/idempotency");
    (idem.logEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ created: false });
    addJob.mockClear();
    addJob.mockResolvedValue(undefined);
    const res = await POST(signed(twoMessages));
    expect(res.status).toBe(200);
    expect(addJob).toHaveBeenCalledTimes(2);
    (idem.logEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ created: true });
  });

  it("still enqueues when logEvent throws — a logging failure must not skip the job", async () => {
    // A failed logEvent must not return early (that would 200 with neither a row nor a job). Fall
    // through to enqueue: if the log failed from a transient DB outage the enqueue fails too → 503
    // → Meta retries (the rescue); otherwise the job is still created. Mirrors the Telegram route.
    const idem = await import("@/lib/idempotency");
    (idem.logEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    addJob.mockClear();
    addJob.mockResolvedValue(undefined);
    const res = await POST(signed(twoMessages));
    expect(res.status).toBe(200);
    expect(addJob).toHaveBeenCalledTimes(2);
    (idem.logEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ created: true });
  });

  it("returns 503 when logEvent and enqueue both fail (the DB-outage rescue path)", async () => {
    const idem = await import("@/lib/idempotency");
    (idem.logEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    addJob.mockReset();
    addJob.mockRejectedValue(new Error("queue down"));
    const res = await POST(signed(twoMessages));
    expect(res.status).toBe(503);
    (idem.logEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ created: true });
    addJob.mockReset();
    addJob.mockResolvedValue(undefined);
  });
});
