import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "rs_live_rules_validation_key_abcdef01";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let rules: typeof import("./route");

const WS = "bbbbbbbb-0000-4000-8000-0000000000d1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  rules = await import("./route");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "R", slug: `r-${WS}` });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "rs_live_ru" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

const post = (body: unknown) =>
  rules.POST(new Request("http://x/api/v1/rules", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

const followGate = (over: Record<string, unknown>) => ({
  name: "Gate",
  response_type: "follow_gate",
  response_config: {
    followed: { text: "Here is your guide" },
    not_followed: { text: "Follow us first", buttons: [{ title: "Claim", payload: "CLAIM_LM" }] },
  },
  ...over,
});

describe("rules validation — follow_gate loop", () => {
  it("rejects a follow_gate rule on a non-postback trigger (loop can't close)", async () => {
    if (!TEST_DB) return;
    const res = await post(followGate({ trigger_type: "keyword", trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] } }));
    expect(res.status).toBe(422);
  });

  it("rejects a follow_gate whose re-prompt button payload doesn't match the trigger payload", async () => {
    if (!TEST_DB) return;
    const res = await post(followGate({
      trigger_type: "postback", trigger_config: { payload: "CLAIM_LM" },
      response_config: { followed: { text: "ok" }, not_followed: { text: "follow", buttons: [{ title: "Claim", payload: "DIFFERENT" }] } },
    }));
    expect(res.status).toBe(422);
  });

  it("accepts a follow_gate on a postback trigger whose re-prompt button re-runs the gate", async () => {
    if (!TEST_DB) return;
    const res = await post(followGate({ trigger_type: "postback", trigger_config: { payload: "CLAIM_LM" } }));
    expect(res.status).toBe(201);
  });
});

describe("rules validation — button URL scheme", () => {
  const withButton = (url: string) => ({
    name: "B", trigger_type: "keyword", trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
    response_type: "text", response_config: { text: "hi", buttons: [{ title: "Open", url }] },
  });

  it("rejects a non-https button URL (javascript:)", async () => {
    if (!TEST_DB) return;
    expect((await post(withButton("javascript:alert(1)"))).status).toBe(422);
  });

  it("rejects a plain http button URL", async () => {
    if (!TEST_DB) return;
    expect((await post(withButton("http://example.com"))).status).toBe(422);
  });

  it("accepts an https button URL", async () => {
    if (!TEST_DB) return;
    expect((await post(withButton("https://example.com/claim"))).status).toBe(201);
  });
});
