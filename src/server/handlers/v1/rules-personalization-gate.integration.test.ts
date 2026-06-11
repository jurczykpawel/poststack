import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "rs_live_persgate_0123456789abcdef0123456789abcdef";
const WS = "9e500000-0000-0000-0000-0000000000a1";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let rules: typeof import("./rules/route");
let gate: typeof import("@/lib/license/gate");
let jwks: typeof import("@/lib/license/jwks");
let jwksUrl: string;
let key: TestKey;

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}
const post = (body: unknown) =>
  new Request("http://x", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const rule = (text: string) => ({
  name: "R",
  trigger_type: "keyword",
  trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
  response_type: "text",
  response_config: { text },
});

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  rules = await import("./rules/route");
  gate = await import("@/lib/license/gate");
  jwks = await import("@/lib/license/jwks");
  ({ env: { LICENSE_JWKS_URL: jwksUrl } } = await import("@/lib/env"));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "PG", slug: `pg-${WS}` });
  await db.insert(s.apiKeys).values({
    workspace_id: WS, name: "k",
    key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "rs_live_persgate",
  });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.autoReplyRules).where(eq(s.autoReplyRules.workspace_id, WS));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

describe("personalization authoring gate on POST /api/v1/rules", () => {
  it("blocks a placeholder rule on a free instance with 402 PRO_REQUIRED", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post(rule("Cześć {imie}!")));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("PRO_REQUIRED");
    expect(body.error.details.feature).toBe("personalization");
    const remaining = await db.select({ id: s.autoReplyRules.id }).from(s.autoReplyRules).where(eq(s.autoReplyRules.workspace_id, WS));
    expect(remaining.length).toBe(0); // no rule persisted
  });

  it("allows a placeholder rule when licensed (pro)", async () => {
    if (!TEST_DB) return;
    await jwks.getJwks({ url: jwksUrl, fetchImpl: jwksFetch([key.jwk]), now: Date.now() });
    await gate.setLicense(await key.sign(makeClaims({ kid: "kid-1", tier: "pro" })), { fetchImpl: jwksFetch([key.jwk]) });
    const res = await rules.POST(post(rule("Cześć {imie}!")));
    expect(res.status).toBe(201);
  });

  it("allows a plain rule (no placeholders) on a free instance", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post(rule("Cześć!")));
    expect(res.status).toBe(201);
  });
});
