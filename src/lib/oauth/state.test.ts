import { describe, it, expect, vi, afterEach } from "vitest";
import { generateOAuthState, verifyOAuthState, clearOAuthStateCookie, OAuthStateExpiredError } from "./state";
import type { SessionAuthContext } from "@/lib/auth";

process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";

const SESSION: SessionAuthContext = {
  userId: "user-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  authMethod: "session",
  scopes: [],
};

const generateOAuthStateFor = generateOAuthState as unknown as (
  auth: SessionAuthContext,
  flow: string,
) => ReturnType<typeof generateOAuthState>;
const verifyOAuthStateFor = verifyOAuthState as unknown as (
  state: string,
  cookieHeader: string | null,
  auth: SessionAuthContext,
  flow: string,
) => void;

describe("OAuth state CSRF token", () => {
  it("generates a random state and an httpOnly Set-Cookie carrying it", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(setCookie).toContain(`rs_oauth_state=${state}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/oauth");
  });

  it("accepts a matching state from the cookie header", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    const cookieHeader = `${setCookie.split(";")[0]}; other=1`;
    expect(() => verifyOAuthStateFor(state, cookieHeader, SESSION, "facebook")).not.toThrow();
  });

  it("rejects a mismatched state", () => {
    expect(() => verifyOAuthStateFor("abc123", "rs_oauth_state=def456", SESSION, "facebook")).toThrow(/Invalid OAuth state/);
  });

  it("rejects when no state cookie is present", () => {
    expect(() => verifyOAuthStateFor("abc123", "unrelated=1", SESSION, "facebook")).toThrow(/OAuth state expired/);
    expect(() => verifyOAuthStateFor("abc123", null, SESSION, "facebook")).toThrow(/OAuth state expired/);
  });

  it("rejects empty state values", () => {
    expect(() => verifyOAuthStateFor("", "rs_oauth_state=", SESSION, "facebook")).toThrow(/Invalid OAuth state/);
  });

  it("clear cookie expires the state", () => {
    expect(clearOAuthStateCookie()).toContain("Max-Age=0");
  });
});

describe("OAuth state identity binding", () => {
  it("accepts the state for the same authenticated user and workspace", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    const cookieHeader = setCookie.split(";")[0]!;

    expect(() => verifyOAuthStateFor(state, cookieHeader, { ...SESSION }, "facebook")).not.toThrow();
  });

  it("rejects the state when a different user completes the callback", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    const cookieHeader = setCookie.split(";")[0]!;

    expect(() =>
      verifyOAuthStateFor(state, cookieHeader, { ...SESSION, userId: "user-b" }, "facebook"),
    ).toThrow(/Invalid OAuth state/);
  });

  it("rejects the state when the user switches workspaces before the callback", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    const cookieHeader = setCookie.split(";")[0]!;

    expect(() =>
      verifyOAuthStateFor(state, cookieHeader, { ...SESSION, workspaceId: "workspace-b" }, "facebook"),
    ).toThrow(/Invalid OAuth state/);
  });

  it("rejects the state after the initiating session changes", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    const cookieHeader = setCookie.split(";")[0]!;

    expect(() =>
      verifyOAuthStateFor(state, cookieHeader, { ...SESSION, sessionId: "session-b" }, "facebook"),
    ).toThrow(/Invalid OAuth state/);
  });

  it("rejects the state on a different connection flow", () => {
    const { state, setCookie } = generateOAuthStateFor(SESSION, "facebook");
    const cookieHeader = setCookie.split(";")[0]!;

    expect(() =>
      verifyOAuthStateFor(state, cookieHeader, SESSION, "instagram"),
    ).toThrow(/Invalid OAuth state/);
  });
});

describe("connect-pages purpose", () => {
  it("round-trips the subAccounts variant for a generic connect flow only", () => {
    const purpose = { kind: "connect" as const, subAccounts: true as const };
    const { state, setCookie } = generateOAuthState(SESSION, "connect:linkedin", purpose);
    expect(verifyOAuthState(state, setCookie.split(";")[0]!, SESSION, "connect:linkedin")).toEqual(purpose);
    expect(() => generateOAuthState(SESSION, "facebook", purpose)).toThrow(/Invalid OAuth purpose/);
    expect(() => generateOAuthState(SESSION, "connect:linkedin", { kind: "connect", subAccounts: false } as never)).toThrow(/Invalid OAuth purpose/);
  });

  it("binds the variant to the signature: the plain flow cannot be relabelled", () => {
    const { state, setCookie } = generateOAuthState(SESSION, "connect:linkedin");
    const [value] = setCookie.split(";");
    const [s, , sig] = value!.slice("rs_oauth_state=".length).split(".");
    const forged = Buffer.from(JSON.stringify({ purpose: { kind: "connect", subAccounts: true }, expiresAt: Date.now() + 60_000 })).toString("base64url");
    expect(() => verifyOAuthState(state, `rs_oauth_state=${s}.${forged}.${sig}`, SESSION, "connect:linkedin")).toThrow(/Invalid OAuth state/);
  });
});

describe("expired vs forged state (LinkedIn invalid_state, 2026-11-11)", () => {
  afterEach(() => vi.useRealTimers());

  it("a missing cookie (browser dropped it after Max-Age) is an expiry, not a forgery", () => {
    const { state } = generateOAuthState(SESSION, "connect:linkedin");
    expect(() => verifyOAuthState(state, null, SESSION, "connect:linkedin")).toThrow(OAuthStateExpiredError);
  });

  it("a validly signed state past its expiry is an expiry", () => {
    vi.useFakeTimers();
    const { state, setCookie } = generateOAuthState(SESSION, "connect:linkedin");
    vi.advanceTimersByTime(11 * 60_000);
    expect(() => verifyOAuthState(state, setCookie.split(";")[0]!, SESSION, "connect:linkedin")).toThrow(OAuthStateExpiredError);
  });

  it("survives a 9 min login but a wrong state stays invalid_state", () => {
    vi.useFakeTimers();
    const { state, setCookie } = generateOAuthState(SESSION, "connect:linkedin");
    vi.advanceTimersByTime(9 * 60_000);
    expect(verifyOAuthState(state, setCookie.split(";")[0]!, SESSION, "connect:linkedin")).toEqual({ kind: "connect" });
    const wrong = () => verifyOAuthState("0".repeat(32), setCookie.split(";")[0]!, SESSION, "connect:linkedin");
    expect(wrong).toThrow(/Invalid OAuth state/);
    expect(wrong).not.toThrow(OAuthStateExpiredError);
  });
});
