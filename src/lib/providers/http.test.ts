import { describe, it, expect, afterEach, vi } from "vitest";
import { classifyHttp, oauth2Refresh } from "./http";
import { TokenInvalidError, TransientError, PermanentError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

describe("classifyHttp", () => {
  it("maps status to typed errors", () => {
    expect(classifyHttp(401)).toBeInstanceOf(TokenInvalidError);
    expect(classifyHttp(403)).toBeInstanceOf(TokenInvalidError);
    expect(classifyHttp(500)).toBeInstanceOf(TransientError);
    expect(classifyHttp(400)).toBeInstanceOf(PermanentError);
  });
});

describe("oauth2Refresh", () => {
  it("maps the token response and preserves the refresh token when none returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 })),
    );
    const t = await oauth2Refresh({
      tokenUrl: "https://x/token",
      clientId: "c",
      clientSecret: "s",
      refreshToken: "OLD",
    });
    expect(t.accessToken).toBe("AT");
    expect(t.refreshToken).toBe("OLD"); // preserved (#1383)
    expect(t.expiresAt).toBeTruthy();
  });

  it("throws TokenInvalidError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })),
    );
    await expect(
      oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "OLD" }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("maps 400 invalid_grant to TokenInvalidError (dead refresh token, not retryable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(
      oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "DEAD" }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
  });
});


describe("OAuth refresh response contract", () => {
  it.each(["invalid_client", "invalid_grant"])("TikTok HTTP 200 %s requires attention", async (error) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error, error_description: "Rejected", log_id: "20261101" })));
    await expect(oauth2Refresh({ tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/", clientId: "c", clientSecret: "s", refreshToken: "RT" })).rejects.toBeInstanceOf(TokenInvalidError);
  });
  it("reports rejected application credentials explicitly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_client" })));
    await expect(oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "RT" })).rejects.toThrow(/application credentials rejected/);
  });
  it("does not send an empty refresh token", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "" })).rejects.toBeInstanceOf(TokenInvalidError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps 503 transient even with an OAuth error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_client" }, { status: 503 })));
    await expect(oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "RT" })).rejects.toBeInstanceOf(TransientError);
  });
});
