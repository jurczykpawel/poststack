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
