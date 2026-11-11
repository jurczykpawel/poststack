import { describe, it, expect, vi, afterEach } from "vitest";
import type { SessionAuthContext } from "@/lib/auth";

process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
// Env the module graph validates at import; no query runs here.
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
const { pickCookie, readPick, clearPickCookie } = await import("./pick");

const AUTH: SessionAuthContext = { userId: "u1", workspaceId: "w1", sessionId: "s1", authMethod: "session", scopes: [] };
const TOKENS = { accessToken: "A".repeat(1000), refreshToken: "R".repeat(1000), expiresAt: "2027-01-01T00:00:00.000Z" };
const header = (setCookie: string) => setCookie.split(";")[0]!;
afterEach(() => vi.useRealTimers());

describe("connect-pages picker cookie", () => {
  it("is an encrypted HttpOnly cookie scoped to the picker that round-trips the token", () => {
    const c = pickCookie("linkedin", TOKENS, AUTH);
    expect(c).toMatch(/^rs_oauth_pick=[A-Za-z0-9_.-]+; HttpOnly; SameSite=Lax; Path=\/channels\/pick; Max-Age=600$/);
    expect(c).not.toContain("AAAA");
    expect(c.length).toBeLessThan(4096); // two 1000-char tokens still fit one cookie
    expect(readPick(header(c), "linkedin", AUTH)).toEqual(TOKENS);
    expect(clearPickCookie()).toContain("Max-Age=0");
  });

  it("returns null for another session, workspace, user or platform, after expiry, and for garbage", () => {
    const c = header(pickCookie("linkedin", TOKENS, AUTH));
    expect(readPick(c, "linkedin", { ...AUTH, sessionId: "s2" })).toBeNull();
    expect(readPick(c, "linkedin", { ...AUTH, workspaceId: "w2" })).toBeNull();
    expect(readPick(c, "linkedin", { ...AUTH, userId: "u2" })).toBeNull();
    expect(readPick(c, "tiktok", AUTH)).toBeNull();
    expect(readPick(null, "linkedin", AUTH)).toBeNull();
    expect(readPick("rs_oauth_pick=not.a.cookie", "linkedin", AUTH)).toBeNull();
    expect(readPick(c.slice(0, -4) + "AAAA", "linkedin", AUTH)).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(readPick(c, "linkedin", AUTH)).toBeNull();
  });
});
