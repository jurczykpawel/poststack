import { describe, it, expect, beforeEach, vi } from "vitest";

const store = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => store }));

import { generateOAuthState, verifyOAuthState } from "./state";

describe("OAuth state CSRF token", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates a random state and stores it in an httpOnly cookie", async () => {
    const state = await generateOAuthState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(store.set).toHaveBeenCalledWith(
      "rs_oauth_state",
      state,
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );
  });

  it("accepts a matching state and consumes the cookie (one-time use)", async () => {
    store.get.mockReturnValueOnce({ value: "abc123" });
    await expect(verifyOAuthState("abc123")).resolves.toBeUndefined();
    expect(store.delete).toHaveBeenCalledWith("rs_oauth_state");
  });

  it("rejects a mismatched state", async () => {
    store.get.mockReturnValueOnce({ value: "abc123" });
    await expect(verifyOAuthState("wrong0")).rejects.toThrow(/Invalid OAuth state/);
  });

  it("rejects when no state cookie is present", async () => {
    store.get.mockReturnValueOnce(undefined);
    await expect(verifyOAuthState("abc123")).rejects.toThrow(/Invalid OAuth state/);
  });
});
