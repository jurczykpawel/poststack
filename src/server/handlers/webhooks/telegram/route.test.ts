import { describe, it, expect, beforeAll, vi } from "vitest";

const addJob = vi.fn();
vi.mock("@/lib/queue/client", () => ({ addJob: (...args: unknown[]) => addJob(...args) }));

// The route fetches all live Telegram channels and matches the secret constant-time in Node
//, so the mock provides findMany returning candidates that carry their webhook_secret.
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { query: { channels: { findMany: (...a: unknown[]) => findMany(...a) } } } }));

let POST: typeof import("./route").POST;

beforeAll(async () => {
  ({ POST } = await import("./route"));
});

function tgReq(secret: string | null, chatType = "private") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-telegram-bot-api-secret-token"] = secret;
  return new Request("http://x/api/webhooks/telegram", {
    method: "POST",
    headers,
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: chatType }, date: 1_770_000_000, text: "hi" } }),
  });
}

describe("telegram webhook delivery", () => {
  it("returns 500 when enqueue fails so Telegram retries instead of dropping the update", async () => {
    findMany.mockResolvedValue([{ id: "ch1", platform_id: "BOT", webhook_secret: "good-secret" }]);
    addJob.mockRejectedValueOnce(new Error("queue down"));
    const res = await POST(tgReq("good-secret"));
    expect(res.status).toBe(500);
  });

  it("returns 200 for an unknown secret (nothing to retry)", async () => {
    findMany.mockResolvedValue([{ id: "ch1", platform_id: "BOT", webhook_secret: "good-secret" }]);
    const res = await POST(tgReq("unknown"));
    expect(res.status).toBe(200);
  });

  it("returns 200 on a successful enqueue", async () => {
    findMany.mockResolvedValue([{ id: "ch1", platform_id: "BOT", webhook_secret: "good-secret" }]);
    addJob.mockResolvedValueOnce(undefined);
    const res = await POST(tgReq("good-secret"));
    expect(res.status).toBe(200);
  });

  // a group/supergroup chat collapses every member to one contact (chat.id is the group,
  // not the member) and aims replies at the group. ReplyStack is a DM inbox: ignore non-private
  // chats (200, not retried) and do NOT enqueue.
  it("ignores a non-private (group) chat without enqueuing", async () => {
    findMany.mockResolvedValue([{ id: "ch1", platform_id: "BOT", webhook_secret: "good-secret" }]);
    addJob.mockClear();
    const res = await POST(tgReq("good-secret", "group"));
    expect(res.status).toBe(200);
    expect(addJob).not.toHaveBeenCalled();
  });

  // the secret is matched constant-time against every live Telegram channel, so among
  // multiple candidates the update is routed to the channel whose secret actually matches (and a
  // non-matching secret enqueues nothing).
  it("routes to the channel whose secret matches among multiple candidates", async () => {
    findMany.mockResolvedValue([
      { id: "ch-a", platform_id: "BOT_A", webhook_secret: "secret-a" },
      { id: "ch-b", platform_id: "BOT_B", webhook_secret: "secret-b" },
    ]);
    addJob.mockClear();
    addJob.mockResolvedValueOnce(undefined);
    const res = await POST(tgReq("secret-b"));
    expect(res.status).toBe(200);
    expect(addJob).toHaveBeenCalledTimes(1);
    expect(addJob).toHaveBeenCalledWith(
      "incoming-message",
      expect.objectContaining({ channelId: "ch-b", pageId: "BOT_B" }),
      expect.any(Object),
    );
  });

  it("enqueues nothing when no channel's secret matches", async () => {
    findMany.mockResolvedValue([
      { id: "ch-a", platform_id: "BOT_A", webhook_secret: "secret-a" },
      { id: "ch-b", platform_id: "BOT_B", webhook_secret: "secret-b" },
    ]);
    addJob.mockClear();
    const res = await POST(tgReq("secret-c"));
    expect(res.status).toBe(200);
    expect(addJob).not.toHaveBeenCalled();
  });
});
