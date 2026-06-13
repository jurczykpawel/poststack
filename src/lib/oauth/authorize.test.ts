import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, createPkcePair } from "./authorize";
import type { OAuthConfig } from "@/lib/providers/types";

const base: OAuthConfig = {
  authorizeUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  scopes: ["read", "write"],
  clientId: "CID",
  clientSecret: "SECRET",
};

describe("buildAuthorizeUrl — drives any provider's oauthConfig", () => {
  it("builds the standard authorization-code URL (client_id, space-joined scopes, state)", () => {
    const u = new URL(buildAuthorizeUrl(base, { state: "ST", redirectUri: "https://app/cb" }));
    expect(u.origin + u.pathname).toBe("https://example.com/authorize");
    expect(u.searchParams.get("client_id")).toBe("CID");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("read write");
    expect(u.searchParams.get("state")).toBe("ST");
  });

  it("honors clientIdParam (TikTok client_key) and scopeSeparator (comma)", () => {
    const u = new URL(buildAuthorizeUrl({ ...base, clientIdParam: "client_key", scopeSeparator: "," }, { state: "ST", redirectUri: "https://app/cb" }));
    expect(u.searchParams.get("client_key")).toBe("CID");
    expect(u.searchParams.get("client_id")).toBeNull();
    expect(u.searchParams.get("scope")).toBe("read,write");
  });

  it("adds extraAuthParams (e.g. access_type=offline, prompt=consent)", () => {
    const u = new URL(buildAuthorizeUrl({ ...base, extraAuthParams: { access_type: "offline", prompt: "consent" } }, { state: "ST", redirectUri: "https://app/cb" }));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("includes the PKCE challenge (S256) when a codeChallenge is supplied", () => {
    const u = new URL(buildAuthorizeUrl(base, { state: "ST", redirectUri: "https://app/cb", codeChallenge: "CHAL" }));
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("createPkcePair — S256 verifier/challenge", () => {
  it("produces a URL-safe verifier and a matching S256 challenge (no padding)", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
    // deterministic: same verifier → same challenge
    const { challenge: again } = createPkcePair(verifier);
    expect(again).toBe(challenge);
  });
});
