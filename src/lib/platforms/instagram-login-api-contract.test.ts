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
 * checkFollowsBusiness, sendPrivateReply. Comments / permalink route by FB-token presence
 * (graph.facebook.com when a page token exists, else graph.instagram.com); publishing the same.
 *
 * Mirror of meta-api-contract.test.ts harness: mocked fetch, captured URLs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GRAPH_API_BASE, IG_GRAPH_BASE } from "./constants";
import { INSTAGRAM_LOGIN_FIELDS } from "./webhook-fields";

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
// IG-Login-ONLY shape: no FB page token, only the IG-Login messaging token.
const IG_ONLY_TOKENS = { access_token: "", messaging_token: "IGQW_ig_login_tok" } as const;

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
      if (url.includes("/refresh_access_token")) {
        // graph.instagram.com long-lived refresh: returns a fresh 60-day token.
        return Response.json({ access_token: "IGQW_new_tok", token_type: "bearer", expires_in: 5_184_000 });
      }
      // getUserProfile
      if (url.includes("fields=name") || url.includes("profile_pic")) {
        return Response.json({ name: "Jane", username: "jane_ig", profile_pic: "https://x/p.jpg" });
      }
      if (url.includes("/subscribed_apps")) return Response.json({ success: true });
      if (url.includes("/replies")) return Response.json({ id: "reply_1" });
      if (url.includes("/comments")) return Response.json({ id: "comment_1" });
      if (url.includes("fields=permalink")) return Response.json({ permalink: "https://www.instagram.com/p/abc/" });
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

  // ─── IG-Login per-account messaging webhook subscription ───────────────────

  describe("subscribeMessagingWebhooks POSTs the IG-Login field set to graph.instagram.com", () => {
    it("POSTs {IG_GRAPH_BASE}/{igUserId}/subscribed_apps with subscribed_fields = INSTAGRAM_LOGIN_FIELDS.join(',')", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ok = await new InstagramProvider().subscribeMessagingWebhooks("IGQW_ig_login_tok", "IGID_99");

      const call = fetchCalls.find((c) => c.url.includes("/subscribed_apps"))!;
      expect(call.url.startsWith(`${IG_GRAPH_BASE}/IGID_99/subscribed_apps`)).toBe(true);
      expect(call.init!.method).toBe("POST");
      // The field set is widened to the parity set incl. `comments`.
      const expected = INSTAGRAM_LOGIN_FIELDS.join(",");
      expect(call.url).toContain(`subscribed_fields=${encodeURIComponent(expected)}`);
      expect(call.url).toContain("access_token=IGQW_ig_login_tok");
      expect(ok).toBe(true);
    });
  });

  // ─── IG-Login messaging token refresh (IGML6) ─────────────────────────────

  describe("refreshMessagingToken hits the unversioned graph.instagram.com refresh endpoint", () => {
    it("GETs {graph.instagram.com origin}/refresh_access_token?grant_type=ig_refresh_token with the IG token and returns {token, expiresAt}", async () => {
      const { InstagramProvider } = await import("./instagram");
      const before = Math.floor(Date.now() / 1000);
      const out = await new InstagramProvider().refreshMessagingToken!("IGQW_old_tok");

      const call = fetchCalls.find((c) => c.url.includes("/refresh_access_token"))!;
      const origin = new URL(IG_GRAPH_BASE).origin; // https://graph.instagram.com (no /vNN)
      expect(call.url.startsWith(`${origin}/refresh_access_token`)).toBe(true);
      expect(call.url).toContain("grant_type=ig_refresh_token");
      expect(call.url).toContain("access_token=IGQW_old_tok");
      // The refresh endpoint is unversioned — never the /vNN host (guarded by version-source.test.ts too).
      expect(call.url).not.toMatch(/graph\.instagram\.com\/v\d/);

      expect(out.token).toBe("IGQW_new_tok");
      expect(out.expiresAt).toBeGreaterThanOrEqual(before + 5_184_000);
      expect(out.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5_184_000);
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

    // A15: an empty-string messaging_token (malformed blob) must be treated as absent → FB branch.
    it("empty-string messaging_token falls back to the FB page token on graph.facebook.com", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().sendMessage(
        { access_token: "fb-page-tok", messaging_token: "" },
        "u1",
        { text: "hi" },
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"))!;
      expect(call.url).toBe(`${GRAPH_API_BASE}/me/messages`);
      expect(JSON.parse(call.init!.body as string).access_token).toBe("fb-page-tok");
    });
  });

  describe("content methods route by FB-token presence (mirror of publish transport)", () => {
    it("IG-Login-ONLY (empty access_token): sendComment → graph.instagram.com with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().sendComment!(IG_ONLY_TOKENS, "ig_comment_9", "Thanks!");
      const call = fetchCalls.find((c) => c.url.includes("/replies"))!;
      expect(call.url).toBe(`${IG_GRAPH_BASE}/ig_comment_9/replies`);
      expect(JSON.parse(call.init!.body as string).access_token).toBe("IGQW_ig_login_tok");
    });
    it("IG-Login-ONLY: commentOnPost → graph.instagram.com with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().commentOnPost!(IG_ONLY_TOKENS, "ig_media_9", "First!");
      const call = fetchCalls.find((c) => c.url.includes("/comments"))!;
      expect(call.url).toBe(`${IG_GRAPH_BASE}/ig_media_9/comments`);
      expect(JSON.parse(call.init!.body as string).access_token).toBe("IGQW_ig_login_tok");
    });
    it("IG-Login-ONLY: getPostUrl → graph.instagram.com with the messaging_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      const url = await new InstagramProvider().getPostUrl!(IG_ONLY_TOKENS, "ig_media_9");
      const call = fetchCalls.find((c) => c.url.includes("fields=permalink"))!;
      expect(call.url.startsWith(`${IG_GRAPH_BASE}/ig_media_9`)).toBe(true);
      expect(call.url).toContain("access_token=IGQW_ig_login_tok");
      expect(url).toBe("https://www.instagram.com/p/abc/");
    });
    it("FB-backed (access_token present, dual or FB-only): sendComment stays on graph.facebook.com with the FB token", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().sendComment!(IG_LOGIN_TOKENS, "ig_comment_9", "Thanks!");
      const call = fetchCalls.find((c) => c.url.includes("/replies"))!;
      expect(call.url).toBe(`${GRAPH_API_BASE}/ig_comment_9/replies`);
      expect(JSON.parse(call.init!.body as string).access_token).toBe("fb-page-tok");
    });
    it("FB-only: getPostUrl stays on graph.facebook.com", async () => {
      const { InstagramProvider } = await import("./instagram");
      await new InstagramProvider().getPostUrl!(FB_ONLY_TOKENS, "ig_media_9");
      const call = fetchCalls.find((c) => c.url.includes("fields=permalink"))!;
      expect(call.url.startsWith(`${GRAPH_API_BASE}/ig_media_9`)).toBe(true);
      expect(call.url).toContain("access_token=fb-page-tok");
    });
  });
});
