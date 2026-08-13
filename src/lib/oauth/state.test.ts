import { describe, it, expect } from "vitest";
import { generateOAuthState, verifyOAuthState, clearOAuthStateCookie } from "./state";
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
    expect(() => verifyOAuthStateFor("abc123", "unrelated=1", SESSION, "facebook")).toThrow(/Invalid OAuth state/);
    expect(() => verifyOAuthStateFor("abc123", null, SESSION, "facebook")).toThrow(/Invalid OAuth state/);
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
