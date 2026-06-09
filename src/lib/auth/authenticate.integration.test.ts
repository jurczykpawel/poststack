import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let auth: typeof import("./index");

const WS = "bbbbbbbb-0000-0000-0000-0000000000a1";
const USER = "bbbbbbbb-0000-0000-0000-0000000000a2";
const EMAIL = "auth-int@example.test";
const RAW_KEY = "rs_live_auth_int_key_abcdef0123456789";
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  auth = await import("./index");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.revokedTokens).where(eq(s.revokedTokens.jti, "auth-int-jti"));
  await db.insert(s.workspaces).values({ id: WS, name: "Auth", slug: `auth-${WS}` });
  await db.insert(s.users).values({ id: USER, email: EMAIL });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER });
  await db.insert(s.apiKeys).values({
    workspace_id: WS, name: "k", key_hash: KEY_HASH, key_prefix: "rs_live_auth", scopes: ["channels:read", "contacts:read"],
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.$client.end?.();
});

const sessionReq = (token: string) =>
  new Request("http://x/api/v1/test", { headers: { cookie: `rs_session=${token}` } });
const keyReq = (k: string) =>
  new Request("http://x/api/v1/test", { headers: { authorization: `Bearer ${k}` } });

describe("authenticate — session (real Postgres)", () => {
  it("authenticates a valid session for an existing user", async () => {
    if (!TEST_DB) return;
    const token = await auth.signSession(USER, WS);
    const ctx = await auth.authenticate(sessionReq(token));
    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe(USER);
    expect(ctx!.workspaceId).toBe(WS);
    expect(ctx!.authMethod).toBe("session");
    expect(ctx!.scopes).toEqual([]);
  });

  it("returns null for a deleted user", async () => {
    if (!TEST_DB) return;
    const token = await auth.signSession(USER, WS);
    await db.delete(s.users).where(eq(s.users.id, USER));
    expect(await auth.authenticate(sessionReq(token))).toBeNull();
  });

  //  — a session must stop authorizing once the user is no longer a member of the
  // workspace named in the token, even though the user still exists.
  it("returns null after the user's workspace membership is removed", async () => {
    if (!TEST_DB) return;
    const token = await auth.signSession(USER, WS);
    expect(await auth.authenticate(sessionReq(token))).not.toBeNull();
    await db.delete(s.workspaceMembers).where(and(eq(s.workspaceMembers.user_id, USER), eq(s.workspaceMembers.workspace_id, WS)));
    expect(await auth.authenticate(sessionReq(token))).toBeNull();
  });

  it("returns null when the jti is on the denylist", async () => {
    if (!TEST_DB) return;
    const token = await auth.signSession(USER, WS);
    await auth.invalidateSession(token);
    expect(await auth.authenticate(sessionReq(token))).toBeNull();
  });
});

describe("authenticate — API key (real Postgres)", () => {
  it("authenticates a valid key with its scopes", async () => {
    if (!TEST_DB) return;
    const ctx = await auth.authenticate(keyReq(RAW_KEY));
    expect(ctx).not.toBeNull();
    expect(ctx!.workspaceId).toBe(WS);
    expect(ctx!.authMethod).toBe("api_key");
    expect(ctx!.scopes).toEqual(["channels:read", "contacts:read"]);
  });

  it("returns null for an unknown key", async () => {
    if (!TEST_DB) return;
    expect(await auth.authenticate(keyReq("rs_live_nope000000000000000000000000"))).toBeNull();
  });

  it("returns null for an expired key", async () => {
    if (!TEST_DB) return;
    await db.update(s.apiKeys).set({ expires_at: new Date("2020-01-01") }).where(eq(s.apiKeys.key_hash, KEY_HASH));
    expect(await auth.authenticate(keyReq(RAW_KEY))).toBeNull();
  });

  it("rejects a key for the wrong workspace when required", async () => {
    if (!TEST_DB) return;
    expect(await auth.authenticate(keyReq(RAW_KEY), "some-other-ws")).toBeNull();
  });
});

describe("invalidateSession (real Postgres)", () => {
  it("adds the jti to the denylist with an expiry within the token lifetime", async () => {
    if (!TEST_DB) return;
    const token = await auth.signSession(USER, WS);
    await auth.invalidateSession(token);
    const rows = await db.select().from(s.revokedTokens);
    const recent = rows.filter((r) => r.expires_at.getTime() > Date.now());
    expect(recent.length).toBeGreaterThan(0);
  });

  //  — logout is unauthenticated, so the caller controls the token. A token merely signed
  // with this JWT_SECRET but with a foreign issuer/audience (e.g. minted by a sibling service that
  // shares the secret) must NOT be able to push an arbitrary jti onto the denylist.
  it("ignores a token with a foreign issuer/audience (jti not denylisted)", async () => {
    if (!TEST_DB) return;
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const foreign = await new SignJWT({ wid: WS })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER)
      .setIssuer("evil")
      .setAudience("evil")
      .setJti("foreign-jti-aud98")
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(secret);

    await auth.invalidateSession(foreign);
    const row = await db.query.revokedTokens.findFirst({ where: eq(s.revokedTokens.jti, "foreign-jti-aud98") });
    expect(row).toBeUndefined();
  });
});
