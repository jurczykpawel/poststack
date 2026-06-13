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

// When the pasted token is a PAGE token, debug_token reports type:"PAGE" → we must connect that ONE
// page via GET /me (NOT enumerate /me/accounts, which a page token cannot do). This is the FREE path.
describe("connectWithToken — pasted PAGE token (single-page, the FREE path)", () => {
  function mockPageToken(meUrlBody: unknown) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      lastUrls.push(url);
      if (url.includes("/debug_token")) {
        return Response.json({ data: { app_id: "test-app-id", is_valid: true, type: "PAGE", profile_id: "P1" } });
      }
      if (url.includes("/me?") || url.includes("/me&") || /\/me$/.test(url.split("?")[0])) {
        return Response.json(meUrlBody);
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  }

  it("Facebook: connects exactly the single page via /me (not /me/accounts)", async () => {
    mockPageToken({ id: "P1", name: "Page One", picture: { data: { url: "u1" } } });
    const { FacebookProvider } = await import("./facebook");
    const accounts = await new FacebookProvider().connectWithToken("PAGE_TOKEN_1");

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ platformId: "P1", displayName: "Page One" });
    expect(accounts[0].tokens.access_token).toBe("PAGE_TOKEN_1");
    expect(accounts[0].tokens.expires_at).toBeUndefined();
    expect(lastUrls.some((u) => u.includes("/me/accounts"))).toBe(false);
    expect(lastUrls.some((u) => u.includes("/me?"))).toBe(true);
  });

  it("Instagram: connects the IG account linked to the single page", async () => {
    mockPageToken({
      id: "P1",
      name: "Page One",
      instagram_business_account: { id: "IG1", name: "IG One", username: "ig_one", profile_picture_url: "p" },
    });
    const { InstagramProvider } = await import("./instagram");
    const accounts = await new InstagramProvider().connectWithToken("PAGE_TOKEN_1");

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ platformId: "IG1", username: "ig_one" });
    expect(accounts[0].tokens.access_token).toBe("PAGE_TOKEN_1");
    expect(accounts[0].tokens.page_id).toBe("P1");
    expect(lastUrls.some((u) => u.includes("/me/accounts"))).toBe(false);
  });
});
