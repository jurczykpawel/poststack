import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const queries = vi.hoisted(() => ({ revoked: vi.fn(), member: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { query: {
  revokedTokens: { findFirst: queries.revoked },
  workspaceMembers: { findFirst: queries.member },
} } }));

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});
beforeEach(() => {
  queries.revoked.mockResolvedValue(undefined);
  queries.member.mockResolvedValue({ user_id: "user-1" });
});

async function signWith(alg: "HS256" | "HS512") {
  const { SignJWT } = await import("jose");
  return new SignJWT({ wid: "ws-1" })
    .setProtectedHeader({ alg }).setSubject("user-1").setJti("login-1")
    .setIssuer("stack").setAudience("stack").setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
}

async function respond(headers: Record<string, string> = {}) {
  const { requireSession } = await import("./page-auth");
  const app = new Hono();
  app.get("/content", requireSession, c => {
    c.header("Cache-Control", "private, max-age=60, no-transform");
    return c.text("session page");
  });
  return app.request("/content", { headers });
}

describe("requireSession", () => {
  it("serves a current session and keeps the response out of storage", async () => {
    const res = await respond({ cookie: `session=${await signWith("HS256")}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("session page");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
  });
  it("redirects a session using a different signing algorithm", async () => {
    const res = await respond({ cookie: `session=${await signWith("HS512")}` });
    expect(res.headers.get("location")).toBe("/login");
  });
  it("redirects an unsigned session", async () => {
    const { UnsecuredJWT } = await import("jose");
    const token = new UnsecuredJWT({ wid: "ws-1", sub: "user-1", jti: "login-1" }).setIssuer("stack").setAudience("stack").setExpirationTime("1h").encode();
    expect((await respond({ cookie: `session=${token}` })).headers.get("location")).toBe("/login");
  });
  it("redirects when there is no cookie", async () => {
    const res = await respond();
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
  it.each(["Bearer sk_live_example", "Basic example", ""])("requires session-only headers (%s)", async authorization => {
    const res = await respond({ cookie: `session=${await signWith("HS256")}`, authorization, "HX-Request": "true" });
    expect(res.headers.get("HX-Redirect")).toBe("/login");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("");
  });
  it("redirects a retired session", async () => {
    queries.revoked.mockResolvedValue({ expires_at: new Date(Date.now() + 60_000) });
    expect((await respond({ cookie: `session=${await signWith("HS256")}` })).headers.get("location")).toBe("/login");
  });
  it("redirects when membership is unavailable", async () => {
    queries.member.mockResolvedValue(undefined);
    expect((await respond({ cookie: `session=${await signWith("HS256")}` })).headers.get("location")).toBe("/login");
  });
});
