import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { META_APP_ID: "test-app-id", META_APP_SECRET: "test-app-secret" },
}));

const fbPages = {
  data: [
    { id: "P1", name: "Page One", access_token: "PAGE_TOKEN_1", picture: { data: { url: "u1" } } },
    { id: "P2", name: "Page Two", access_token: "PAGE_TOKEN_2" },
  ],
};
const igPages = {
  data: [
    {
      id: "P1",
      name: "Page One",
      access_token: "PAGE_TOKEN_1",
      instagram_business_account: { id: "IG1", name: "IG One", username: "ig_one", profile_picture_url: "p" },
    },
    { id: "P2", name: "No IG Page", access_token: "PAGE_TOKEN_2" },
  ],
};

const originalFetch = globalThis.fetch;
let lastUrls: string[] = [];

beforeEach(() => {
  lastUrls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    lastUrls.push(url);
    if (url.includes("/me/accounts") && url.includes("instagram_business_account")) {
      return Response.json(igPages);
    }
    if (url.includes("/me/accounts")) return Response.json(fbPages);
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("FacebookProvider.connectWithToken — paste a long-lived token", () => {
  it("resolves managed pages using the pasted token, with non-expiring tokens", async () => {
    const { FacebookProvider } = await import("./facebook");
    const accounts = await new FacebookProvider().connectWithToken("SYSUSER_TOKEN");

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ platformId: "P1", displayName: "Page One" });
    expect(accounts[0].tokens.access_token).toBe("PAGE_TOKEN_1");
    expect(accounts[0].tokens.expires_at).toBeUndefined();
    expect(lastUrls.some((u) => u.includes("access_token=SYSUSER_TOKEN"))).toBe(true);
  });
});

describe("InstagramProvider.connectWithToken — paste a long-lived token", () => {
  it("resolves linked IG business accounts with non-expiring tokens", async () => {
    const { InstagramProvider } = await import("./instagram");
    const accounts = await new InstagramProvider().connectWithToken("SYSUSER_TOKEN");

    expect(accounts).toHaveLength(1); // page without IG filtered out
    expect(accounts[0]).toMatchObject({ platformId: "IG1", username: "ig_one" });
    expect(accounts[0].tokens.access_token).toBe("PAGE_TOKEN_1");
    expect(accounts[0].tokens.expires_at).toBeUndefined();
  });
});
