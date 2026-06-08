import { describe, it, expect, beforeAll, vi } from "vitest";

const addJob = vi.fn();
vi.mock("@/lib/queue/client", () => ({ addJob: (...args: unknown[]) => addJob(...args) }));

const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({ db: { query: { channels: { findFirst: (...a: unknown[]) => findFirst(...a) } } } }));

let POST: typeof import("./route").POST;

beforeAll(async () => {
  ({ POST } = await import("./route"));
});

function tgReq(secret: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-telegram-bot-api-secret-token"] = secret;
  return new Request("http://x/api/webhooks/telegram", {
    method: "POST",
    headers,
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: "private" }, date: 1_770_000_000, text: "hi" } }),
  });
}

describe("telegram webhook delivery", () => {
  it("returns 500 when enqueue fails so Telegram retries instead of dropping the update", async () => {
    findFirst.mockResolvedValue({ id: "ch1", platform_id: "BOT" });
    addJob.mockRejectedValueOnce(new Error("queue down"));
    const res = await POST(tgReq("good-secret"));
    expect(res.status).toBe(500);
  });

  it("returns 200 for an unknown secret (nothing to retry)", async () => {
    findFirst.mockResolvedValue(undefined);
    const res = await POST(tgReq("unknown"));
    expect(res.status).toBe(200);
  });

  it("returns 200 on a successful enqueue", async () => {
    findFirst.mockResolvedValue({ id: "ch1", platform_id: "BOT" });
    addJob.mockResolvedValueOnce(undefined);
    const res = await POST(tgReq("good-secret"));
    expect(res.status).toBe(200);
  });
});
