import { describe, it, expect } from "vitest";
import { generateOAuthState, verifyOAuthState, clearOAuthStateCookie } from "./state";

describe("OAuth state CSRF token", () => {
  it("generates a random state and an httpOnly Set-Cookie carrying it", () => {
    const { state, setCookie } = generateOAuthState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(setCookie).toContain(`rs_oauth_state=${state}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("accepts a matching state from the cookie header", () => {
    const { state } = generateOAuthState();
    expect(() => verifyOAuthState(state, `rs_oauth_state=${state}; other=1`)).not.toThrow();
  });

  it("rejects a mismatched state", () => {
    expect(() => verifyOAuthState("abc123", "rs_oauth_state=def456")).toThrow(/Invalid OAuth state/);
  });

  it("rejects when no state cookie is present", () => {
    expect(() => verifyOAuthState("abc123", "unrelated=1")).toThrow(/Invalid OAuth state/);
    expect(() => verifyOAuthState("abc123", null)).toThrow(/Invalid OAuth state/);
  });

  it("clear cookie expires the state", () => {
    expect(clearOAuthStateCookie()).toContain("Max-Age=0");
  });
});
