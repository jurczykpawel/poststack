import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "sse-ui@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let notifyRealtime: typeof import("@/lib/events").notifyRealtime;
let app: Hono;
let cookie = "";
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/session=[^;]+/);
  return m ? m[0] : "";
}

/** Read SSE chunks from a reader (shared across calls so the stream isn't re-locked) until
 *  `predicate(buf)` holds or the timeout elapses; accumulates into `state.buf`. Keeps a single
 *  in-flight read so the reader is never re-entered (which would throw). */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buf: string; pending?: Promise<ReadableStreamReadResult<Uint8Array>> },
  predicate: (buf: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate(state.buf)) {
    if (!state.pending) state.pending = reader.read();
    const timed = new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 250));
    const r = await Promise.race([state.pending, timed]);
    if (r === "tick") continue; // read still in flight — re-check predicate / deadline
    state.pending = undefined;
    if (r.done) break;
    if (r.value) state.buf += decoder.decode(r.value, { stream: true });
  }
  return state.buf;
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.REGISTRATION_ENABLED = "true";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ db } = await import("@/lib/db"));
  ({ notifyRealtime } = await import("@/lib/events"));
  const { buildApp } = await import("../app");
  app = buildApp();

  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL), columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  await db.delete(users).where(eq(users.email, EMAIL));
  // Clear the shared rate-limit table so registration isn't blocked by counters from earlier suites.
  const { sql } = await import("drizzle-orm");
  await db.execute(sql.raw("DELETE FROM rate_limit_counters"));
  const res = await app.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = cookieFrom(res);
  const user = await db.query.users.findFirst({
    where: eq(users.email, EMAIL), columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true }, limit: 1 } },
  });
  workspaceId = user!.workspaceMembers[0].workspace_id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  const { stopRealtimeListener } = await import("@/lib/realtime/hub");
  await stopRealtimeListener();
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.$client.end();
});

describe("GET /events/stream (SSE)", () => {
  it("401 without a session", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/events/stream");
    expect(res.status).toBe(401);
  });

  it("authed stream opens with a ready event and delivers this workspace's signals", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/events/stream", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const state = { buf: "" };
    try {
      // The stream should open with the `ready` event.
      await readUntil(reader, state, (b) => b.includes("event: ready"));
      expect(state.buf).toContain("event: ready");

      // A NOTIFY for THIS workspace surfaces as an SSE event; another workspace's must not.
      await notifyRealtime(db, "some-other-workspace", "comment", "foreign");
      await notifyRealtime(db, workspaceId, "comment", "mine-123");
      await readUntil(reader, state, (b) => b.includes("mine-123"));
      expect(state.buf).toContain("event: comment");
      expect(state.buf).toContain("mine-123");
      expect(state.buf).not.toContain("foreign"); // cross-workspace isolation on the wire
    } finally {
      await reader.cancel().catch(() => {});
    }
  });
});
