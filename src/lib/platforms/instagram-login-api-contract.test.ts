/**
 * Instagram Business Login (IG-Login) API Contract Tests — IGML2.
 *
 * When a channel carries an IG-Login messaging token (`TokenData.messaging_token`), the messaging
 * surface MUST route to `graph.instagram.com` (IG_GRAPH_BASE) with THAT token — NOT to
 * `graph.facebook.com` with the FB page token. This was validated LIVE at Standard Access (no App
 * Review): sending via graph.instagram.com + `is_user_follow_business` follow-check both work.
 *
 * Without a `messaging_token`, the same methods must FALL BACK to the FB page token on
 * graph.facebook.com (GRAPH_API_BASE) — the existing managed/Advanced-Access path.
 *
 * Routing applies to the four messaging methods ONLY: sendMessage, getUserProfile,
 * checkFollowsBusiness, sendPrivateReply. Comments / publishing stay on graph.facebook.com.
 *
 * Mirror of meta-api-contract.test.ts harness: mocked fetch, captured URLs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GRAPH_API_BASE, IG_GRAPH_BASE } from "./constants";

// --- Mock env before importing providers ---
vi.mock("@/lib/env", () => ({
  env: {
    META_APP_ID: "test-app-id",
    META_APP_SECRET: "test-app-secret",
    META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  },
}));

// CONFIG1: providers resolve Meta creds via getConfig (DB-or-env). Pure unit test, no DB → mock it.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) =>
    ({ META_APP_ID: "test-app-id", META_APP_SECRET: "test-app-secret", META_WEBHOOK_VERIFY_TOKEN: "test-verify-token" } as Record<string, string>)[key] ?? "",
}));

// Capture all fetch calls
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const originalFetch = globalThis.fetch;

// IG-Login token blob: the FB page token sits in access_token (fallback), the IG-Login messaging
// token in messaging_token (preferred transport when present).
const IG_LOGIN_TOKENS = { access_token: "fb-page-tok", messaging_token: "IGQW_ig_login_tok" } as const;
const FB_ONLY_TOKENS = { access_token: "fb-page-tok" } as const;

describe("Instagram Business Login API Contract (IGML2)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });

      if (url.includes("/me/messages")) {
        return Response.json({ recipient_id: "u1", message_id: "m_ig_001" });
      }
      if (url.includes("is_user_follow_business")) {
        return Response.json({ is_user_follow_business: true });
      }
      // getUserProfile
      if (url.includes("fields=name") || url.includes("profile_pic")) {
        return Response.json({ name: "Jane", username: "jane_ig", profile_pic: "https://x/p.jpg" });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── IG-Login token present → graph.instagram.com ──────────────────────

  describe("messaging_token present → routes to IG_GRAPH_BASE with the IG-Login token", () => {
    it("sendMessage POSTs to {IG_GRAPH_BASE}/me/messages with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().sendMessage(IG_LOGIN_TOKENS, "ig_user_1", { text: "Hi" });

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"))!;
      expect(call.url).toBe(`${IG_GRAPH_BASE}/me/messages`);
      const body = JSON.parse(call.init!.body as string);
      expect(body.recipient).toEqual({ id: "ig_user_1" });
      expect(body.message.text).toBe("Hi");
      expect(body.access_token).toBe("IGQW_ig_login_tok");
    });

    it("getUserProfile GETs {IG_GRAPH_BASE}/{id}?fields=name,username,profile_pic with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().getUserProfile!(IG_LOGIN_TOKENS, "IGSID_7");

      const call = fetchCalls.find((c) => c.url.includes("IGSID_7"))!;
      expect(call.url.startsWith(`${IG_GRAPH_BASE}/`)).toBe(true);
      expect(call.url).toContain("fields=name,username,profile_pic");
      expect(call.url).toContain("access_token=IGQW_ig_login_tok");
    });

    it("checkFollowsBusiness GETs {IG_GRAPH_BASE}/{id}?fields=is_user_follow_business with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      const follows = await new InstagramProvider().checkFollowsBusiness!(IG_LOGIN_TOKENS, "IGSID_42");

      const call = fetchCalls.find((c) => c.url.includes("IGSID_42"))!;
      expect(call.url.startsWith(`${IG_GRAPH_BASE}/`)).toBe(true);
      expect(call.url).toContain("fields=is_user_follow_business");
      expect(call.url).toContain("access_token=IGQW_ig_login_tok");
      expect(follows).toBe(true);
    });

    it("sendPrivateReply POSTs to {IG_GRAPH_BASE}/me/messages with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().sendPrivateReply!(IG_LOGIN_TOKENS, "ig_comment_1", { text: "Tap to claim" });

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"))!;
      expect(call.url).toBe(`${IG_GRAPH_BASE}/me/messages`);
      const body = JSON.parse(call.init!.body as string);
      expect(body.recipient).toEqual({ comment_id: "ig_comment_1" });
      expect(body.access_token).toBe("IGQW_ig_login_tok");
    });

    it("every messaging fetch targets graph.instagram.com (never graph.facebook.com) when IG-Login token present", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.sendMessage(IG_LOGIN_TOKENS, "u1", { text: "hi" });
      await ig.getUserProfile!(IG_LOGIN_TOKENS, "u1");
      await ig.checkFollowsBusiness!(IG_LOGIN_TOKENS, "u1");
      await ig.sendPrivateReply!(IG_LOGIN_TOKENS, "c1", { text: "hi" });

      expect(fetchCalls.length).toBeGreaterThan(0);
      for (const call of fetchCalls) {
        expect(call.url.startsWith(IG_GRAPH_BASE)).toBe(true);
        expect(call.url).not.toContain("graph.facebook.com");
      }
    });
  });

  // ─── No IG-Login token → fall back to FB page token on graph.facebook.com ──

  describe("messaging_token absent → falls back to FB page token on GRAPH_API_BASE", () => {
    it("sendMessage uses graph.facebook.com with the FB page token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().sendMessage(FB_ONLY_TOKENS, "u1", { text: "hi" });

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"))!;
      expect(call.url).toBe(`${GRAPH_API_BASE}/me/messages`);
      const body = JSON.parse(call.init!.body as string);
      expect(body.access_token).toBe("fb-page-tok");
    });

    it("checkFollowsBusiness uses graph.facebook.com with the FB page token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().checkFollowsBusiness!(FB_ONLY_TOKENS, "IGSID_1");

      const call = fetchCalls.find((c) => c.url.includes("IGSID_1"))!;
      expect(call.url.startsWith(`${GRAPH_API_BASE}/`)).toBe(true);
      expect(call.url).toContain("access_token=fb-page-tok");
    });
  });
});
