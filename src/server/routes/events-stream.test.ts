import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionAuthContext } from "@/lib/auth";
import { GET } from "./events-stream";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticateDashboard: mocks.auth }));
vi.mock("@/lib/realtime/hub", () => ({ startRealtimeListener: vi.fn(), subscribe: mocks.subscribe }));
const session: SessionAuthContext = { userId: "user", workspaceId: "workspace", sessionId: "login", authMethod: "session", scopes: [] };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.auth.mockReset().mockResolvedValue(session);
  mocks.unsubscribe.mockClear();
  mocks.subscribe.mockReset().mockReturnValue(mocks.unsubscribe);
});
afterEach(() => vi.useRealTimers());

it.each(["ended", "unavailable", "workspace", "login", "user"])("closes an open stream when its session is %s", async state => {
  const app = new Hono().get("/events/stream", GET);
  const res = await app.request("/events/stream");
  const reader = res.body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    if (state === "unavailable") mocks.auth.mockRejectedValue(new Error("Unavailable"));
    else mocks.auth.mockResolvedValue(state === "ended" ? null : { ...session, [state === "workspace" ? "workspaceId" : state === "login" ? "sessionId" : "userId"]: "changed" });
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await next).done).toBe(true);
    expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(mocks.auth.mock.calls[1][0]).toBe(mocks.auth.mock.calls[0][0]);
    expect(mocks.unsubscribe).toHaveBeenCalled();
  } finally {
    await reader.cancel();
  }
});

it("keeps heartbeat and workspace signals on a current session", async () => {
  const res = await new Hono().get("/events/stream", GET).request("/events/stream");
  const reader = res.body!.getReader();
  try {
    await reader.read();
    const heartbeat = reader.read();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(new TextDecoder().decode((await heartbeat).value)).toContain("event: heartbeat");
    expect(mocks.auth).toHaveBeenCalledTimes(2);
    mocks.subscribe.mock.calls[0][1]({ kind: "comment", id: "current-comment" });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: current-comment");
  } finally {
    await reader.cancel();
  }
  expect(mocks.unsubscribe).toHaveBeenCalled();
});
