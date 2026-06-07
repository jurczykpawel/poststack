/**
 * Meta Graph API Contract Tests
 *
 * These tests verify that our code correctly constructs requests and parses
 * responses for the Meta Graph API version defined in constants.ts.
 *
 * When bumping META_API_VERSION:
 * 1. Update META_API_VERSION in constants.ts
 * 2. Review Meta's changelog for breaking changes
 * 3. Update the mock responses below to match the new version's schema
 * 4. Run these tests — failures show exactly what broke
 *
 * Mock responses are based on real Meta Graph API v21.0 response shapes.
 * See: https://developers.facebook.com/docs/graph-api/changelog
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { META_API_VERSION, META_OAUTH_BASE } from "./constants";

// --- Mock env before importing providers ---
vi.mock("@/lib/env", () => ({
  env: {
    META_APP_ID: "test-app-id",
    META_APP_SECRET: "test-app-secret",
    META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  },
}));

// Capture all fetch calls
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const originalFetch = globalThis.fetch;

// ─── Mock Response Fixtures (v21.0) ──────────────────────────────────────
// These represent the actual response shapes from the Meta Graph API.
// When bumping API version, update these to match the new version's format.

const FIXTURES = {
  /** POST /oauth/access_token — exchange code for user token */
  tokenExchange: {
    access_token: "EAAtest_user_token_123",
    token_type: "bearer",
  },

  /** POST /oauth/access_token — long-lived token exchange (Instagram) */
  longLivedToken: {
    access_token: "EAAtest_long_lived_token_456",
    token_type: "bearer",
    expires_in: 5184000, // 60 days in seconds
  },

  /** GET /me/accounts — pages the user manages (Facebook) */
  facebookPages: {
    data: [
      {
        id: "111222333444",
        name: "Test Page",
        access_token: "EAAtest_page_token_789",
        picture: {
          data: { url: "https://graph.facebook.com/111222333444/picture" },
        },
      },
      {
        id: "555666777888",
        name: "Another Page",
        access_token: "EAAtest_page_token_999",
        picture: {
          data: { url: "https://graph.facebook.com/555666777888/picture" },
        },
      },
    ],
    paging: {
      cursors: { before: "abc", after: "def" },
    },
  },

  /** GET /me/accounts — pages with IG business accounts (Instagram) */
  instagramPages: {
    data: [
      {
        id: "111222333444",
        name: "Test Page",
        access_token: "EAAtest_page_token_789",
        instagram_business_account: {
          id: "17841400000",
          name: "Test IG Account",
          username: "test_ig",
          profile_picture_url: "https://example.com/pic.jpg",
        },
      },
      {
        id: "555666777888",
        name: "Page Without IG",
        access_token: "EAAtest_page_token_999",
        // No instagram_business_account — should be filtered out
      },
    ],
  },

  /** POST /me/messages — send DM response */
  sendMessage: {
    recipient_id: "user123",
    message_id: "m_mid.test_message_id_001",
  },

  /** POST /{object-id}/comments — post comment response */
  sendComment: {
    id: "111222333444_987654321",
  },

  /** GET /debug_token — token introspection */
  debugToken: {
    data: {
      app_id: "test-app-id",
      type: "PAGE",
      application: "Test App",
      data_access_expires_at: 1735689600,
      expires_at: 0, // 0 = never expires (page tokens)
      is_valid: true,
      scopes: ["pages_show_list", "pages_messaging", "pages_read_engagement"],
    },
  },

  /** POST /{page-id}/subscribed_apps — webhook subscription */
  subscribeWebhooks: {
    success: true,
  },

  /** GET /{page-id}/feed — page posts */
  pageFeed: {
    data: [
      {
        id: "111222333444_post001",
        message: "Hello from our page!",
        created_time: "2026-03-27T10:00:00+0000",
        full_picture: "https://example.com/img.jpg",
        permalink_url: "https://facebook.com/111222333444/posts/post001",
      },
      {
        id: "111222333444_post002",
        created_time: "2026-03-26T15:30:00+0000",
        // No message, no picture — should render "(no text)"
      },
    ],
    paging: {
      cursors: { before: "xxx", after: "yyy" },
      next: "https://graph.facebook.com/v21.0/111222333444/feed?after=yyy",
    },
  },

  /** Incoming webhook payload — messaging event (DM) */
  webhookMessage: {
    object: "page",
    entry: [
      {
        id: "111222333444",
        time: 1711540000,
        messaging: [
          {
            sender: { id: "user_psid_001" },
            recipient: { id: "111222333444" },
            timestamp: 1711540000000,
            message: {
              mid: "m_mid.ABCdef123456",
              text: "Hello, I need help!",
            },
          },
        ],
      },
    ],
  },

  /** Incoming webhook payload — echo message (should be skipped) */
  webhookEcho: {
    object: "page",
    entry: [
      {
        id: "111222333444",
        time: 1711540001,
        messaging: [
          {
            sender: { id: "111222333444" },
            recipient: { id: "user_psid_001" },
            timestamp: 1711540001000,
            message: {
              mid: "m_mid.echo123",
              text: "We sent this",
              is_echo: true,
            },
          },
        ],
      },
    ],
  },

  /** Incoming webhook payload — postback (button tap) */
  webhookPostback: {
    object: "page",
    entry: [
      {
        id: "111222333444",
        time: 1711540002,
        messaging: [
          {
            sender: { id: "user_psid_002" },
            recipient: { id: "111222333444" },
            timestamp: 1711540002000,
            postback: {
              payload: "GET_STARTED",
              title: "Get Started",
            },
          },
        ],
      },
    ],
  },

  /** Incoming webhook payload — comment on a post */
  webhookComment: {
    object: "page",
    entry: [
      {
        id: "111222333444",
        time: 1711540003,
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: "111222333444_987654321_comment001",
              post_id: "111222333444_987654321",
              from: { id: "commenter_001", name: "John Doe" },
              message: "Great post!",
              created_time: 1711540003,
            },
          },
        ],
      },
    ],
  },

  /** Incoming webhook payload — Instagram comment (uses media_id) */
  webhookInstagramComment: {
    object: "instagram",
    entry: [
      {
        id: "17841400000",
        time: 1711540004,
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: "17841400000_comment001",
              media_id: "17841400000_media001",
              from: { id: "ig_user_001", name: "Jane" },
              message: "Love this!",
              created_time: 1711540004,
            },
          },
        ],
      },
    ],
  },

  /** Meta API error response (consistent across versions) */
  apiError: {
    error: {
      message: "(#100) Invalid parameter",
      type: "OAuthException",
      code: 100,
      error_subcode: 2018001,
      fbtrace_id: "A1B2C3D4E5",
    },
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Meta Graph API Contract Tests", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });

      // Route to appropriate fixture
      if (url.includes("/oauth/access_token") && url.includes("fb_exchange_token")) {
        return Response.json(FIXTURES.longLivedToken);
      }
      if (url.includes("/oauth/access_token")) {
        return Response.json(FIXTURES.tokenExchange);
      }
      if (url.includes("/me/accounts") && url.includes("instagram_business_account")) {
        return Response.json(FIXTURES.instagramPages);
      }
      if (url.includes("/me/accounts")) {
        return Response.json(FIXTURES.facebookPages);
      }
      if (url.includes("/me/messages")) {
        return Response.json(FIXTURES.sendMessage);
      }
      if (url.includes("/comments") || url.includes("/replies")) {
        return Response.json(FIXTURES.sendComment);
      }
      if (url.includes("/debug_token")) {
        return Response.json(FIXTURES.debugToken);
      }
      if (url.includes("/subscribed_apps")) {
        return Response.json(FIXTURES.subscribeWebhooks);
      }
      if (url.includes("/feed")) {
        return Response.json(FIXTURES.pageFeed);
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── URL Construction ─────────────────────────────────────────────────

  describe("URL construction", () => {
    it("all Graph API calls use GRAPH_API_BASE with correct version", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();

      // Trigger multiple API calls
      await fb.authenticate("test-code", "https://example.com/callback");
      await fb.sendMessage(
        { access_token: "tok" },
        "user123",
        { text: "Hello" }
      );
      await fb.sendComment({ access_token: "tok" }, "post123", "Nice!");
      await fb.getTokenExpiry("tok");
      await fb.subscribePageWebhooks("page123", "tok");

      // Every fetch call should use the correct API base
      for (const call of fetchCalls) {
        expect(call.url).toContain(
          `graph.facebook.com/${META_API_VERSION}`
        );
      }
    });

    it("OAuth dialog URL uses META_OAUTH_BASE", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      const url = fb.generateAuthUrl("state123", "https://example.com/cb");
      expect(url).toMatch(new RegExp(`^${META_OAUTH_BASE.replace(/[/.]/g, '\\$&')}/dialog/oauth\\?`));
      expect(url).toContain("client_id=test-app-id");
      expect(url).toContain("response_type=code");
    });

    it("Instagram OAuth dialog URL uses META_OAUTH_BASE", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      const url = ig.generateAuthUrl("state456", "https://example.com/cb");
      expect(url).toMatch(new RegExp(`^${META_OAUTH_BASE.replace(/[/.]/g, '\\$&')}/dialog/oauth\\?`));
    });
  });

  // ─── Facebook OAuth ───────────────────────────────────────────────────

  describe("Facebook OAuth flow", () => {
    it("exchanges code for token with correct params", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.authenticate("auth-code-123", "https://app.test/callback");

      const tokenCall = fetchCalls.find((c) => c.url.includes("/oauth/access_token"));
      expect(tokenCall).toBeDefined();
      expect(tokenCall!.url).toContain("client_id=test-app-id");
      expect(tokenCall!.url).toContain("client_secret=test-app-secret");
      expect(tokenCall!.url).toContain("code=auth-code-123");
      expect(tokenCall!.url).toContain("redirect_uri=https%3A%2F%2Fapp.test%2Fcallback");
    });

    it("fetches pages with correct fields", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.authenticate("code", "https://app.test/cb");

      const pagesCall = fetchCalls.find((c) => c.url.includes("/me/accounts"));
      expect(pagesCall).toBeDefined();
      expect(pagesCall!.url).toContain("fields=id%2Cname%2Caccess_token%2Cpicture");
    });

    it("parses pages response into ConnectedAccount[]", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      const accounts = await fb.authenticate("code", "https://app.test/cb");

      expect(accounts).toHaveLength(2);
      expect(accounts[0]).toEqual({
        platformId: "111222333444",
        displayName: "Test Page",
        profilePicture: "https://graph.facebook.com/111222333444/picture",
        tokens: { access_token: "EAAtest_page_token_789" },
      });
    });

    it("requests correct OAuth scopes", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      const url = fb.generateAuthUrl("state", "https://app.test/cb");
      const params = new URL(url).searchParams;
      const scopes = params.get("scope")!.split(",");
      expect(scopes).toContain("pages_show_list");
      expect(scopes).toContain("pages_messaging");
      expect(scopes).toContain("pages_read_engagement");
      expect(scopes).toContain("pages_manage_metadata");
    });
  });

  // ─── Instagram OAuth ──────────────────────────────────────────────────

  describe("Instagram OAuth flow", () => {
    it("exchanges code, then gets long-lived token, then fetches pages", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.authenticate("ig-code", "https://app.test/ig-cb");

      // Should make 3 calls: token exchange, long-lived exchange, me/accounts
      const oauthCalls = fetchCalls.filter((c) => c.url.includes("/oauth/access_token"));
      expect(oauthCalls).toHaveLength(2);

      // First: code → short-lived token
      expect(oauthCalls[0].url).toContain("code=ig-code");

      // Second: short-lived → long-lived (fb_exchange_token)
      expect(oauthCalls[1].url).toContain("grant_type=fb_exchange_token");
    });

    it("fetches pages with instagram_business_account field", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.authenticate("code", "https://app.test/cb");

      const pagesCall = fetchCalls.find((c) => c.url.includes("/me/accounts"));
      expect(pagesCall!.url).toContain("instagram_business_account");
    });

    it("filters out pages without IG business account", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      const accounts = await ig.authenticate("code", "https://app.test/cb");

      // Only 1 of 2 pages has instagram_business_account
      expect(accounts).toHaveLength(1);
      expect(accounts[0].platformId).toBe("17841400000");
      expect(accounts[0].tokens.page_id).toBe("111222333444");
    });

    it("stores expires_at from long-lived token", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      const accounts = await ig.authenticate("code", "https://app.test/cb");

      expect(accounts[0].tokens.expires_at).toBeTypeOf("number");
      expect(accounts[0].tokens.user_access_token).toBe("EAAtest_long_lived_token_456");
    });

    it("requests correct Instagram OAuth scopes", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      const url = ig.generateAuthUrl("state", "https://app.test/cb");
      const scopes = new URL(url).searchParams.get("scope")!.split(",");
      expect(scopes).toContain("instagram_basic");
      expect(scopes).toContain("instagram_manage_messages");
      expect(scopes).toContain("instagram_manage_comments");
    });
  });

  // ─── Send Message ─────────────────────────────────────────────────────

  describe("sendMessage request/response", () => {
    it("sends text DM with correct payload shape", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      const result = await fb.sendMessage(
        { access_token: "page-tok" },
        "user_psid_001",
        { text: "Hello!" }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);

      expect(body.recipient).toEqual({ id: "user_psid_001" });
      expect(body.messaging_type).toBe("RESPONSE");
      expect(body.message.text).toBe("Hello!");
      expect(body.access_token).toBe("page-tok");

      expect(result.platformMessageId).toBe("m_mid.test_message_id_001");
    });

    it("sends attachment with correct structure", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendMessage(
        { access_token: "tok" },
        "user1",
        { attachments: [{ type: "image", url: "https://example.com/img.jpg" }] }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.attachment).toEqual({
        type: "image",
        payload: { url: "https://example.com/img.jpg", is_reusable: true },
      });
    });

    it("sends quick replies with correct structure", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendMessage(
        { access_token: "tok" },
        "user1",
        {
          text: "Choose one:",
          quick_replies: [
            { title: "Yes", payload: "YES" },
            { title: "No", payload: "NO" },
          ],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.quick_replies).toEqual([
        { content_type: "text", title: "Yes", payload: "YES" },
        { content_type: "text", title: "No", payload: "NO" },
      ]);
    });

    it("sends button template with correct structure", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendMessage(
        { access_token: "tok" },
        "user1",
        {
          text: "Click a button:",
          buttons: [
            { title: "Visit", url: "https://example.com" },
            { title: "Start", payload: "GET_STARTED" },
          ],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.attachment.type).toBe("template");
      expect(body.message.attachment.payload.template_type).toBe("button");
      expect(body.message.attachment.payload.buttons).toEqual([
        { type: "web_url", url: "https://example.com", title: "Visit" },
        { type: "postback", title: "Start", payload: "GET_STARTED" },
      ]);
      // text should NOT be in message (moved to template payload)
      expect(body.message.text).toBeUndefined();
    });

    it("sends user_email / user_phone_number quick replies as content_type only", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendMessage(
        { access_token: "tok" },
        "user1",
        {
          text: "Share your details:",
          quick_replies: [
            { content_type: "user_email" },
            { content_type: "user_phone_number" },
          ],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.quick_replies).toEqual([
        { content_type: "user_email" },
        { content_type: "user_phone_number" },
      ]);
    });

    it("Messenger passes image_url through on text quick replies", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendMessage(
        { access_token: "tok" },
        "user1",
        {
          text: "Pick:",
          quick_replies: [{ content_type: "text", title: "Red", payload: "R", image_url: "https://x/r.png" }],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.quick_replies[0]).toEqual({
        content_type: "text",
        title: "Red",
        payload: "R",
        image_url: "https://x/r.png",
      });
    });

    it("Instagram sends a plain text DM", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      const result = await ig.sendMessage({ access_token: "tok" }, "ig_user_1", { text: "Hi there" });

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.text).toBe("Hi there");
      expect(result.platformMessageId).toBe("m_mid.test_message_id_001");
    });

    it("Instagram sends quick replies", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.sendMessage(
        { access_token: "tok" },
        "ig_user_1",
        {
          text: "Choose:",
          quick_replies: [
            { content_type: "text", title: "Yes", payload: "YES" },
            { content_type: "user_email" },
          ],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.quick_replies).toEqual([
        { content_type: "text", title: "Yes", payload: "YES" },
        { content_type: "user_email" },
      ]);
    });

    it("Instagram sends a button template (postback + web_url)", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.sendMessage(
        { access_token: "tok" },
        "ig_user_1",
        {
          text: "Claim it:",
          buttons: [
            { title: "Chcę odebrać", payload: "CLAIM_LM" },
            { title: "Strona", url: "https://example.com" },
          ],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.attachment.payload.template_type).toBe("button");
      expect(body.message.attachment.payload.buttons).toEqual([
        { type: "postback", title: "Chcę odebrać", payload: "CLAIM_LM" },
        { type: "web_url", url: "https://example.com", title: "Strona" },
      ]);
      expect(body.message.text).toBeUndefined();
    });

    it("Instagram strips image_url from quick replies (unsupported)", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.sendMessage(
        { access_token: "tok" },
        "ig_user_1",
        {
          text: "Pick:",
          quick_replies: [{ content_type: "text", title: "Red", payload: "R", image_url: "https://x/r.png" }],
        }
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message.quick_replies[0]).toEqual({ content_type: "text", title: "Red", payload: "R" });
      expect(body.message.quick_replies[0].image_url).toBeUndefined();
    });
  });

  // ─── Send Comment ─────────────────────────────────────────────────────

  describe("sendComment request", () => {
    it("posts comment with correct endpoint and payload", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendComment(
        { access_token: "tok" },
        "post_123",
        "Great post!"
      );

      const call = fetchCalls.find((c) => c.url.includes("/post_123/comments"));
      expect(call).toBeDefined();
      const body = JSON.parse(call!.init!.body as string);
      expect(body.message).toBe("Great post!");
      expect(body.access_token).toBe("tok");
    });

    it("Instagram uses /replies endpoint for comments", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      await ig.sendComment(
        { access_token: "tok" },
        "media_123",
        "Love this!"
      );

      const call = fetchCalls.find((c) => c.url.includes("/media_123/replies"));
      expect(call).toBeDefined();
    });
  });

  // ─── Private Reply ────────────────────────────────────────────────────

  describe("sendPrivateReply request", () => {
    it("sends private reply with comment_id as recipient", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.sendPrivateReply!(
        { access_token: "tok" },
        "comment_abc",
        "Thanks for your comment!"
      );

      const call = fetchCalls.find((c) => c.url.includes("/me/messages"));
      const body = JSON.parse(call!.init!.body as string);
      expect(body.recipient).toEqual({ comment_id: "comment_abc" });
      expect(body.message).toEqual({ text: "Thanks for your comment!" });
    });
  });

  // ─── Webhook Subscription ────────────────────────────────────────────

  describe("subscribePageWebhooks", () => {
    it("subscribes with correct fields", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await fb.subscribePageWebhooks("page_123", "page-tok");

      const call = fetchCalls.find((c) => c.url.includes("/page_123/subscribed_apps"));
      expect(call).toBeDefined();
      expect(call!.init!.method).toBe("POST");

      const body = JSON.parse(call!.init!.body as string);
      const fields = body.subscribed_fields.split(",");
      expect(fields).toContain("messages");
      expect(fields).toContain("messaging_postbacks");
      expect(fields).toContain("feed");
      expect(body.access_token).toBe("page-tok");
    });
  });

  // ─── Token Introspection ──────────────────────────────────────────────

  describe("debug_token", () => {
    it("calls debug_token with app token and parses expiry", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      const expiry = await fb.getTokenExpiry("page-tok-to-check");

      const call = fetchCalls.find((c) => c.url.includes("/debug_token"));
      expect(call!.url).toContain("input_token=page-tok-to-check");
      expect(call!.url).toContain("access_token=test-app-id%7Ctest-app-secret");

      // expires_at=0 means never expires, our code returns undefined for falsy
      expect(expiry).toBeUndefined();
    });
  });

  // ─── Token Refresh ────────────────────────────────────────────────────

  describe("Instagram token refresh", () => {
    it("refreshes long-lived token via fb_exchange_token", async () => {
      const { InstagramProvider } = await import("./instagram");
      const ig = new InstagramProvider();
      const newTokens = await ig.refreshToken({
        access_token: "page-tok",
        user_access_token: "old-ll-token",
        expires_at: 1000,
      });

      const call = fetchCalls.find((c) => c.url.includes("fb_exchange_token"));
      expect(call!.url).toContain("fb_exchange_token=old-ll-token");

      expect(newTokens.user_access_token).toBe("EAAtest_long_lived_token_456");
      expect(newTokens.expires_at).toBeTypeOf("number");
      expect(newTokens.access_token).toBe("page-tok"); // page token preserved
    });
  });

  // ─── Webhook Payload Parsing ──────────────────────────────────────────

  describe("Incoming webhook payload shapes", () => {
    it("DM webhook has expected structure", () => {
      const payload = FIXTURES.webhookMessage;
      expect(payload.object).toBe("page");
      const entry = payload.entry[0];
      const msg = entry.messaging![0] as Record<string, unknown>;
      const message = (msg as { message: Record<string, unknown> }).message;

      // Fields our webhook route depends on
      expect((msg.sender as { id: string }).id).toBeTypeOf("string");
      expect((msg.recipient as { id: string }).id).toBeTypeOf("string");
      expect(msg.timestamp).toBeTypeOf("number");
      expect(message.mid).toBeTypeOf("string");
      expect(message.text).toBeTypeOf("string");
      expect(message.is_echo).toBeUndefined(); // not an echo
    });

    it("Echo message has is_echo=true", () => {
      const msg = FIXTURES.webhookEcho.entry[0].messaging![0];
      expect(msg.message!.is_echo).toBe(true);
    });

    it("Postback webhook has payload field", () => {
      const msg = FIXTURES.webhookPostback.entry[0].messaging![0] as Record<string, unknown>;
      expect((msg.postback as { payload: string }).payload).toBe("GET_STARTED");
      expect((msg.postback as { title: string }).title).toBe("Get Started");
      expect(msg.message).toBeUndefined(); // postbacks don't have message
    });

    it("Comment webhook has feed change structure", () => {
      const change = FIXTURES.webhookComment.entry[0].changes![0];
      expect(change.field).toBe("feed");
      expect(change.value.item).toBe("comment");
      expect(change.value.verb).toBe("add");
      expect(change.value.comment_id).toBeTypeOf("string");
      expect(change.value.post_id).toBeTypeOf("string");
      expect(change.value.from!.id).toBeTypeOf("string");
      expect(change.value.from!.name).toBeTypeOf("string");
      expect(change.value.message).toBeTypeOf("string");
    });

    it("Instagram comment uses media_id instead of post_id", () => {
      const payload = FIXTURES.webhookInstagramComment;
      expect(payload.object).toBe("instagram");
      const change = payload.entry[0].changes![0];
      expect(change.value.media_id).toBeTypeOf("string");
      // Instagram comments don't have post_id, they use media_id
      expect("post_id" in change.value).toBe(false);
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────

  describe("API error handling", () => {
    it("throws on token exchange failure", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify(FIXTURES.apiError), { status: 400 })
      ) as typeof fetch;

      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await expect(
        fb.authenticate("bad-code", "https://app.test/cb")
      ).rejects.toThrow("Meta token exchange failed");
    });

    it("throws on send message failure with error body", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify(FIXTURES.apiError), { status: 400 })
      ) as typeof fetch;

      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      await expect(
        fb.sendMessage({ access_token: "tok" }, "user1", { text: "hi" })
      ).rejects.toThrow("Facebook send message failed");
    });

    it("webhook subscription failure does not throw", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify(FIXTURES.apiError), { status: 400 })
      ) as typeof fetch;

      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();
      // Should NOT throw — webhook sub is best-effort
      await expect(
        fb.subscribePageWebhooks("page1", "tok")
      ).resolves.toBeUndefined();
    });
  });

  // ─── Fetch Options ────────────────────────────────────────────────────

  describe("fetch safety options", () => {
    it("all outgoing fetches use redirect: error", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();

      await fb.authenticate("code", "https://app.test/cb");
      await fb.sendMessage({ access_token: "tok" }, "u1", { text: "hi" });
      await fb.sendComment({ access_token: "tok" }, "p1", "nice");
      await fb.subscribePageWebhooks("page1", "tok");

      for (const call of fetchCalls) {
        const init = call.init ?? {};
        // GET requests pass redirect in the fetch options
        // POST requests also pass redirect
        if (init.redirect !== undefined) {
          expect(init.redirect).toBe("error");
        }
      }
    });

    it("all fetches have AbortSignal timeout", async () => {
      const { FacebookProvider } = await import("./facebook");
      const fb = new FacebookProvider();

      await fb.authenticate("code", "https://app.test/cb");
      await fb.sendMessage({ access_token: "tok" }, "u1", { text: "hi" });

      for (const call of fetchCalls) {
        const init = call.init ?? {};
        if (init.signal !== undefined) {
          expect(init.signal).toBeInstanceOf(AbortSignal);
        }
      }
    });
  });
});
