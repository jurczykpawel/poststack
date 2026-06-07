import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "crypto";

const APP_SECRET = "partial-enqueue-secret";

// addJob is driven per-test; rateLimit is stubbed so the handler needs no DB.
const addJob = vi.fn();
vi.mock("@/lib/queue/client", () => ({
  addJob: (...args: unknown[]) => addJob(...args),
  closeQueue: vi.fn(),
}));
vi.mock("@/lib/api/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

let POST: typeof import("./route").POST;

beforeAll(async () => {
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
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
});
