import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runSmoke } from "../scripts/ci/live-telegram-smoke";

const fixture = JSON.parse(readFileSync("tests/fixtures/provider-docs/telegram-responses.json", "utf8"));
const env = { LIVE_TG_BOT_TOKEN: "test-token", LIVE_TG_CHAT_ID: "-1001234567890", GITHUB_SHA: "a".repeat(40) };
function mockApi(fail = "") {
  let id = 100;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    calls.push({ method, body: JSON.parse(init.body as string) });
    if (method === fail) return Response.json({ ok: false }, { status: 500 });
    const result = method === "getMe" ? fixture.me.result : method === "getChat" ? { ...fixture.chatPrivateChannel.result, id: Number(env.LIVE_TG_CHAT_ID) } : method === "getChatMember" ? fixture.memberAdminCanPost.result : method === "deleteMessage" ? true : method === "sendMediaGroup" ? fixture.album.result.map((message: object) => ({ ...message, message_id: ++id })) : { ...fixture.message.result, message_id: ++id };
    return Response.json({ ok: true, result });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
it("requires credentials before making calls", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(runSmoke({})).rejects.toThrow("LIVE_TG_BOT_TOKEN and LIVE_TG_CHAT_ID");
  expect(fetcher).not.toHaveBeenCalled();
});
it("validates admin, publishes four formats and deletes all five messages", async () => {
  const calls = mockApi();
  await runSmoke(env, async () => {});
  expect(calls.map(c => c.method)).toEqual(["getMe", "getChat", "getChatMember", "sendMessage", "sendPhoto", "sendVideo", "sendMediaGroup", ...Array(5).fill("deleteMessage")]);
  expect(calls.filter(c => c.method === "deleteMessage").map(c => c.body.message_id)).toEqual(["101", "102", "103", "104", "105"]);
  expect(calls.find(c => c.method === "sendVideo")?.body.video).toContain(`/${env.GITHUB_SHA}/tests/fixtures/live/telegram.mp4`);
});
it("cleans prior publications when a later publish fails", async () => {
  const calls = mockApi("sendVideo");
  await expect(runSmoke(env, async () => {})).rejects.toThrow();
  expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(2);
});
it("attempts every deletion and fails if cleanup fails", async () => {
  const calls = mockApi("deleteMessage");
  await expect(runSmoke(env, async () => {})).rejects.toThrow("Cleanup failed");
  expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(5);
});
it("blocks release builds and manual PROD on the Telegram gate", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  expect(release).toContain("needs: [verify, dependabot-gate, live-telegram]");
  expect(release).toContain("needs.live-telegram.result == 'success'");
  expect(release).toMatch(/deploy-prod:[\s\S]*needs: live-telegram/);
});

it("does not publish when the bot cannot post to the channel", async () => {
  fixture.memberAdminCanPost.result.can_post_messages = false;
  const calls = mockApi();
  try {
    await expect(runSmoke(env, async () => {})).rejects.toThrow("administrator");
    expect(calls.map(c => c.method)).toEqual(["getMe", "getChat", "getChatMember"]);
  } finally { fixture.memberAdminCanPost.result.can_post_messages = true; }
});
it("fails on a response without message_id and cleans earlier messages", async () => {
  const original = fixture.album.result;
  const calls = mockApi();
  // The provider rejects an empty album response before a handle is returned.
  fixture.album.result = [];
  try {
    await expect(runSmoke(env, async () => {})).rejects.toThrow("message_id");
    expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(3);
  } finally { fixture.album.result = original; }
});
