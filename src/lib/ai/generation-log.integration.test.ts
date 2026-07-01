import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let logGeneration: typeof import("./generation-log").logGeneration;

const WS = "c0ffee07-0000-4000-8000-000000000d01";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ logGeneration } = await import("./generation-log"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await seedWorkspace(db, s, { id: WS, slug: `adlog-${WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

async function rows() {
  return db.query.aiGenerationLogs.findMany({ where: eq(s.aiGenerationLogs.workspace_id, WS) });
}

describe.skipIf(!TEST_DB)("logGeneration", () => {
  it("writes a full row on a successful completion", async () => {
    await logGeneration({ workspaceId: WS, kind: "draft", model: "gpt-4o-mini", system: "sys", user: "usr", response: "hi there", error: null, durationMs: 123 });
    const [row] = await rows();
    expect(row.kind).toBe("draft");
    expect(row.model).toBe("gpt-4o-mini");
    expect(row.system_prompt).toBe("sys");
    expect(row.user_message).toBe("usr");
    expect(row.response).toBe("hi there");
    expect(row.error).toBeNull();
    expect(row.duration_ms).toBe(123);
  });

  it("writes a row with response null and error set on a failed/empty completion", async () => {
    await logGeneration({ workspaceId: WS, kind: "rephrase", model: "gpt-4o-mini", system: "sys", user: "usr", response: null, error: "HTTP 500", durationMs: 45 });
    const [row] = await rows();
    expect(row.response).toBeNull();
    expect(row.error).toBe("HTTP 500");
  });

  it("neutralizes HTML metacharacters in attacker-reachable fields (defence-in-depth stored-XSS)", async () => {
    await logGeneration({ workspaceId: WS, kind: "draft", model: "m", system: "sys", user: "<script>alert(1)</script>", response: "<b>hi</b>", error: null, durationMs: 1 });
    const [row] = await rows();
    expect(row.user_message).not.toContain("<script>");
    expect(row.user_message).toContain("＜script＞");
    expect(row.response).not.toContain("<b>");
  });

  it("strips control characters (log injection)", async () => {
    await logGeneration({ workspaceId: WS, kind: "draft", model: "m", system: "sys", user: "line1\r\nFAKE 200 OK", response: null, error: null, durationMs: 1 });
    const [row] = await rows();
    expect(row.user_message).toBe("line1FAKE 200 OK");
  });

  it("is workspace-scoped: a row never leaks into another workspace's query", async () => {
    const OTHER = "c0ffee07-0000-4000-8000-000000000d02";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER));
    await seedWorkspace(db, s, { id: OTHER, slug: `adlog-other-${OTHER}` });
    await logGeneration({ workspaceId: OTHER, kind: "draft", model: "m", system: "s", user: "u", response: "r", error: null, durationMs: 1 });
    expect(await rows()).toHaveLength(0);
    await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER));
  });

  it("is best-effort: an invalid workspace_id (FK violation) is swallowed, never throws", async () => {
    await expect(
      logGeneration({ workspaceId: "00000000-0000-4000-8000-000000000000", kind: "draft", model: "m", system: "s", user: "u", response: "r", error: null, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });
});
