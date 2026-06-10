import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "rs_live_rules_validation_key_abcdef01";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let rules: typeof import("./route");
let rule: typeof import("./[ruleId]/route");

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
  rule = await import("./[ruleId]/route");
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

describe("rules PATCH — grandfathering + case", () => {
  const patch = (id: string, body: unknown) =>
    rule.PATCH(
      new Request("http://x", { method: "PATCH", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ ruleId: id }) },
    );

  it("lets a grandfathered rule (legacy http:// button) be toggled despite the stricter https refine", async () => {
    if (!TEST_DB) return;
    // Seed a rule with an http:// button DIRECTLY (bypassing the create validation), as if it was
    // created before the https-only refine landed.
    const [r] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Legacy", trigger_type: "keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text", response_config: { text: "hi", buttons: [{ title: "Open", url: "http://legacy.example.com" }] },
    }).returning({ id: s.autoReplyRules.id });

    // A patch that does NOT touch the offending button config must still go through.
    const res = await patch(r.id, { is_active: false });
    expect(res.status).toBe(200);

    // But genuinely setting a NEW invalid value is still rejected.
    const bad = await patch(r.id, { response_config: { text: "hi", buttons: [{ title: "X", url: "http://still-bad.example.com" }] } });
    expect(bad.status).toBe(422);
  });

  it("lets an untouched legacy button round-trip when editing only the text inside response_config", async () => {
    if (!TEST_DB) return;
    const [r] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Legacy2", trigger_type: "keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text", response_config: { text: "old", buttons: [{ title: "Open", url: "http://legacy.example.com" }] },
    }).returning({ id: s.autoReplyRules.id });

    // response_config is replaced wholesale, so changing only the text means resending the WHOLE
    // object including the unchanged legacy button. That untouched button must not re-trip the refine.
    const ok = await patch(r.id, { response_config: { text: "new copy", buttons: [{ title: "Open", url: "http://legacy.example.com" }] } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { response_config: { text: string } } };
    expect(body.data.response_config.text).toBe("new copy");

    // Changing the button itself to a new http:// value is still rejected.
    const bad = await patch(r.id, { response_config: { text: "new copy", buttons: [{ title: "Open", url: "http://changed.example.com" }] } });
    expect(bad.status).toBe(422);
  });

  it("round-trips an unchanged OBJECT-valued legacy violation when editing a sibling", async () => {
    if (!TEST_DB) return;
    // Button with BOTH url and payload → a pre-existing "exactly one of" violation whose Zod issue
    // path is the whole button OBJECT (a valid https url, so only that refine trips). jsonb stores
    // the button's keys canonically (url, title, payload); the client body uses its own order — the
    // grandfather compare must be key-order-insensitive or it falsely re-rejects.
    const [r] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "ObjLegacy", trigger_type: "keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text", response_config: { text: "old", buttons: [{ title: "Open", url: "https://x.example.com", payload: "claim" }] },
    }).returning({ id: s.autoReplyRules.id });

    // Edit only the text; resend the SAME button with keys in a different order than jsonb stores them.
    const ok = await patch(r.id, { response_config: { text: "new", buttons: [{ payload: "claim", title: "Open", url: "https://x.example.com" }] } });
    expect(ok.status).toBe(200);

    // Actually changing the button (still both url+payload, new url) is still rejected.
    const bad = await patch(r.id, { response_config: { text: "new", buttons: [{ title: "Open", url: "https://y.example.com", payload: "claim" }] } });
    expect(bad.status).toBe(422);
  });

  it("accepts a follow_gate whose button payload differs only in case from the trigger payload", async () => {
    if (!TEST_DB) return;
    const res = await post({
      name: "GateCase", trigger_type: "postback", trigger_config: { payload: "CLAIM_LM" },
      response_type: "follow_gate",
      response_config: { followed: { text: "ok" }, not_followed: { text: "follow", buttons: [{ title: "Claim", payload: "claim_lm" }] } },
    });
    expect(res.status).toBe(201);
  });
});

const keywordRule = (value: string) => ({
  name: "K", trigger_type: "keyword",
  trigger_config: { keywords: [{ value, match_type: "contains" }] },
  response_type: "text", response_config: { text: "hi" },
});

describe("rules validation — cooldown bound", () => {
  it("rejects an over-max cooldown_seconds (would push the cooldown timestamp out of range)", async () => {
    if (!TEST_DB) return;
    expect((await post({ ...keywordRule("hi"), cooldown_seconds: 9_000_000_000_000_000 })).status).toBe(422);
  });
  it("accepts a cooldown within the 1-year bound", async () => {
    if (!TEST_DB) return;
    expect((await post({ ...keywordRule("yo"), cooldown_seconds: 3600 })).status).toBe(201);
  });
});

describe("rules validation — keyword whitespace", () => {
  it("rejects a whitespace-only keyword (would collapse to a catch-all)", async () => {
    if (!TEST_DB) return;
    expect((await post(keywordRule(" "))).status).toBe(422);
    expect((await post(keywordRule("\t\n"))).status).toBe(422);
  });

  it("trims surrounding whitespace and stores the trimmed value", async () => {
    if (!TEST_DB) return;
    const res = await post(keywordRule("hi "));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { trigger_config: { keywords: { value: string }[] } } };
    expect(body.data.trigger_config.keywords[0].value).toBe("hi");
  });
});

describe("rules active-rule cap", () => {
  it("rejects creating a rule once the workspace is at the active-rule cap", async () => {
    if (!TEST_DB) return;
    const { MAX_ACTIVE_RULES } = await import("@/lib/rules/executor");
    await db.insert(s.autoReplyRules).values(
      Array.from({ length: MAX_ACTIVE_RULES }, (_, i) => ({
        workspace_id: WS, name: `bulk-${i}`, trigger_type: "keyword" as const,
        trigger_config: { keywords: [{ value: "x", match_type: "contains" }] },
        response_type: "text" as const, response_config: { text: "hi" },
      })),
    );
    const res = await post(keywordRule("one-too-many"));
    expect(res.status).toBe(422);
  });

  //  — the cap is also enforced on a PATCH is_active false→true, so it can't be toggle-bypassed.
  it("rejects re-activating a rule via PATCH once the workspace is at the active-rule cap", async () => {
    if (!TEST_DB) return;
    const { MAX_ACTIVE_RULES } = await import("@/lib/rules/executor");
    await db.insert(s.autoReplyRules).values(
      Array.from({ length: MAX_ACTIVE_RULES }, (_, i) => ({
        workspace_id: WS, name: `cap-${i}`, trigger_type: "keyword" as const,
        trigger_config: { keywords: [{ value: "x", match_type: "contains" }] },
        response_type: "text" as const, response_config: { text: "hi" },
      })),
    );
    const [inactive] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "inactive", trigger_type: "keyword", is_active: false,
      trigger_config: { keywords: [{ value: "x", match_type: "contains" }] },
      response_type: "text", response_config: { text: "hi" },
    }).returning({ id: s.autoReplyRules.id });

    const res = await rule.PATCH(
      new Request("http://x", { method: "PATCH", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ is_active: true }) }),
      { params: Promise.resolve({ ruleId: inactive.id }) },
    );
    expect(res.status).toBe(422);
  });
});
