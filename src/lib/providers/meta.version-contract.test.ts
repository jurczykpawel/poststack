/**
 * Publishing-layer Graph API CONTRACT tests (VPROBE1-B).
 *
 * `meta-api-contract.test.ts` pins the INBOUND/messaging providers (platforms/facebook.ts,
 * instagram.ts) to the configured Graph version. This file does the same for the PUBLISHING layer
 * (`providers/meta.ts` — the MetaProvider that publishes posts/reels/photos/videos/stories and runs
 * the managed-connection token introspection).
 *
 * The publishing layer once silently drifted to a hardcoded `v21.0` while messaging was on `v25.0`
 * (see VPROBE1). `version-source.test.ts` catches a re-introduced *literal* statically; THIS file
 * catches it dynamically by asserting every outgoing publish-flow fetch URL starts with
 * `GRAPH_API_BASE` (i.e. carries `/${META_API_VERSION}`) and hits the expected edge with the expected
 * method/shape. A `META_API_VERSION` bump that any publish edge fails to follow fails here.
 *
 * Deterministic: fetch is mocked, no network, no DB. App creds come from process.env (debugToken /
 * me/accounts paths require them; getConfig falls back to env when there's no DB).
 *
 * Changelog: https://developers.facebook.com/docs/graph-api/changelog
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
// Cover/media fetches route through the SSRF guard (safeFetch → DNS resolve). Stub DNS to a public
// IP so these unit tests never hit the network for fake hostnames (mirrors meta.publish.test.ts).
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] }));
import { metaProvider } from "./meta";
import { GRAPH_API_BASE, META_API_VERSION } from "@/lib/platforms/constants";

const tokens = { accessToken: "T-publish" };

// Capture every outgoing fetch (url + init) so we can assert the version + edge + shape.
type Call = { url: string; init?: RequestInit };
let calls: Call[];

function installPublishFetch(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}

const APP_ID = "test-app-id";
const savedAppId = process.env.META_APP_ID;
const savedSecret = process.env.META_APP_SECRET;

beforeAll(() => {
  // PSA10: the managed connection (inspectSource / enumerateSubAccounts) requires app creds.
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = "test-app-secret";
});
afterAll(() => {
  process.env.META_APP_ID = savedAppId;
  process.env.META_APP_SECRET = savedSecret;
});
beforeEach(() => {
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

/** Only the calls that go to the Meta Graph API (graph.facebook.com). The reel upload step POSTs to a
 *  separate resumable-upload host (rupload.facebook.com) which is intentionally NOT versioned —
 *  exclude those from the version assertion. */
function graphCalls(): Call[] {
  return calls.filter((c) => c.url.includes("graph.facebook.com"));
}

function bodyString(init?: RequestInit): string {
  return String(init?.body ?? "");
}

describe("MetaProvider publishing layer — Graph API version contract (VPROBE1-B)", () => {
  // ─── The headline guard: every publish-flow graph.facebook.com call carries the configured version ─

  describe("every publish-flow graph.facebook.com call uses GRAPH_API_BASE", () => {
    it("IG image feed_post (container → status poll → media_publish) — all on GRAPH_API_BASE", async () => {
      installPublishFetch((url) => {
        if (url.includes("/media_publish")) return Response.json({ id: "ig_img_1" });
        if (url.includes("?fields=status_code")) return Response.json({ status_code: "FINISHED" });
        return Response.json({ id: "container_img" }); // POST /{ig}/media
      });

      const h = await metaProvider.publish({
        tokens,
        accountId: "IGID",
        request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "hi", options: { mediaKind: "image" } },
        mediaUrls: ["https://cdn/x.jpg"],
        channelMetadata: { subKind: "instagram" },
      });
      expect(h.providerHandle).toBe("ig_img_1");

      for (const c of graphCalls()) {
        expect(c.url.startsWith(GRAPH_API_BASE), `not on GRAPH_API_BASE: ${c.url}`).toBe(true);
        expect(c.url).toContain(`graph.facebook.com/${META_API_VERSION}`);
      }
    });

    it("FB reel (video_reels start → upload → finish) — every graph call on GRAPH_API_BASE", async () => {
      installPublishFetch((url) => {
        if (url.includes("/video_reels") && url.includes("upload_phase=start"))
          return Response.json({ video_id: "r1", upload_url: "https://rupload.facebook.com/r1" });
        if (url === "https://rupload.facebook.com/r1") return Response.json({ success: true });
        if (url.includes("/video_reels") && url.includes("upload_phase=finish"))
          return Response.json({ success: true, post_id: "fbr1" });
        return Response.json({});
      });

      const h = await metaProvider.publish({
        tokens,
        accountId: "PAGE",
        request: { format: "reel", media: [{ mediaId: "m" }], caption: "c" },
        mediaUrls: ["https://cdn/x.mp4"],
        channelMetadata: { subKind: "facebook_page" },
      });
      expect(h.providerHandle).toBe("fbr1");

      // The resumable-upload host is intentionally unversioned; assert ONLY the graph.facebook.com calls.
      const graph = graphCalls();
      expect(graph.length).toBeGreaterThanOrEqual(2); // start + finish
      for (const c of graph) {
        expect(c.url.startsWith(GRAPH_API_BASE), `not on GRAPH_API_BASE: ${c.url}`).toBe(true);
      }
      // sanity: the upload step did target the non-graph resumable host (so the filter is meaningful)
      expect(calls.some((c) => c.url === "https://rupload.facebook.com/r1")).toBe(true);
    });

    it("IG story (STORIES container → poll → media_publish) — all on GRAPH_API_BASE", async () => {
      installPublishFetch((url) => {
        if (url.includes("/media_publish")) return Response.json({ id: "story_1" });
        if (url.includes("?fields=status_code")) return Response.json({ status_code: "FINISHED" });
        return Response.json({ id: "container_s" });
      });

      await metaProvider.publishStory!({
        tokens,
        accountId: "IGID",
        mediaUrl: "https://cdn/card.jpg",
        channelMetadata: { subKind: "instagram" },
      });
      for (const c of graphCalls()) {
        expect(c.url.startsWith(GRAPH_API_BASE), `not on GRAPH_API_BASE: ${c.url}`).toBe(true);
      }
    });

    it("managed-connection introspection (debug_token + me/accounts) uses GRAPH_API_BASE", async () => {
      installPublishFetch((url) => {
        if (url.includes("/debug_token"))
          return Response.json({ data: { app_id: APP_ID, type: "USER", user_id: "9", is_valid: true } });
        if (url.includes("/me/accounts"))
          return Response.json({ data: [{ id: "p1", name: "Page", access_token: "PT1" }] });
        return Response.json({});
      });

      await metaProvider.inspectSource!(tokens);
      await metaProvider.enumerateSubAccounts!(tokens);

      const introspection = graphCalls().filter(
        (c) => c.url.includes("/debug_token") || c.url.includes("/me/accounts"),
      );
      expect(introspection.length).toBe(2);
      for (const c of introspection) {
        expect(c.url.startsWith(GRAPH_API_BASE), `not on GRAPH_API_BASE: ${c.url}`).toBe(true);
      }
    });
  });

  // ─── Per-edge version + endpoint + method assertions (the shapes the code actually emits) ─────────

  describe("IG image: POST /{ig}/media (container) then POST /{ig}/media_publish", () => {
    it("hits both edges on the configured version, container before publish", async () => {
      installPublishFetch((url) => {
        if (url.includes("/media_publish")) return Response.json({ id: "ig_img_2" });
        if (url.includes("?fields=status_code")) return Response.json({ status_code: "FINISHED" });
        return Response.json({ id: "cont_x" });
      });

      await metaProvider.publish({
        tokens,
        accountId: "IGID",
        request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "cap", options: { mediaKind: "image" } },
        mediaUrls: ["https://cdn/x.jpg"],
        channelMetadata: { subKind: "instagram" },
      });

      const container = calls.find((c) => c.url.includes("/IGID/media") && !c.url.includes("media_publish"))!;
      expect(container.url).toBe(`${GRAPH_API_BASE}/IGID/media`);
      expect(container.init?.method).toBe("POST");
      // IG image container: `url=` (not media_type/video_url), caption passed through
      const cbody = decodeURIComponent(bodyString(container.init));
      expect(cbody).toContain("url=https://cdn/x.jpg");
      expect(cbody).toContain("caption=cap");
      expect(cbody).not.toContain("media_type=");

      const status = calls.find((c) => c.url.includes("?fields=status_code"))!;
      expect(status.url.startsWith(`${GRAPH_API_BASE}/cont_x?fields=status_code`)).toBe(true);

      const publish = calls.find((c) => c.url.includes("/media_publish"))!;
      expect(publish.url).toBe(`${GRAPH_API_BASE}/IGID/media_publish`);
      expect(publish.init?.method).toBe("POST");
      expect(bodyString(publish.init)).toContain("creation_id=cont_x");
    });
  });

  describe("IG reel: POST /{ig}/media (media_type=REELS, video_url=) then media_publish", () => {
    it("creates a REELS container on the configured version", async () => {
      installPublishFetch((url) => {
        if (url.includes("/media_publish")) return Response.json({ id: "ig_reel_1" });
        if (url.includes("?fields=status_code")) return Response.json({ status_code: "FINISHED" });
        return Response.json({ id: "cont_reel" });
      });

      await metaProvider.publish({
        tokens,
        accountId: "IGID",
        request: { format: "reel", media: [{ mediaId: "m" }], caption: "c" },
        mediaUrls: ["https://cdn/x.mp4"],
        channelMetadata: { subKind: "instagram" },
      });

      const container = calls.find((c) => c.url.includes("/IGID/media") && !c.url.includes("media_publish"))!;
      expect(container.url).toBe(`${GRAPH_API_BASE}/IGID/media`);
      const cbody = decodeURIComponent(bodyString(container.init));
      expect(cbody).toContain("media_type=REELS");
      expect(cbody).toContain("video_url=https://cdn/x.mp4");
    });
  });

  describe("FB reel: POST /{page}/video_reels (start) → finish", () => {
    it("start and finish phases both target /{page}/video_reels on the configured version", async () => {
      installPublishFetch((url) => {
        if (url.includes("/video_reels") && url.includes("upload_phase=start"))
          return Response.json({ video_id: "v9", upload_url: "https://rupload.facebook.com/v9" });
        if (url === "https://rupload.facebook.com/v9") return Response.json({ success: true });
        if (url.includes("/video_reels") && url.includes("upload_phase=finish"))
          return Response.json({ success: true, post_id: "fbr9" });
        return Response.json({});
      });

      await metaProvider.publish({
        tokens,
        accountId: "PAGE",
        request: { format: "reel", media: [{ mediaId: "m" }], caption: "cap" },
        mediaUrls: ["https://cdn/x.mp4"],
        channelMetadata: { subKind: "facebook_page" },
      });

      const start = calls.find((c) => c.url.includes("/video_reels") && c.url.includes("upload_phase=start"))!;
      expect(start.url.startsWith(`${GRAPH_API_BASE}/PAGE/video_reels`)).toBe(true);
      expect(start.init?.method).toBe("POST");

      const finish = calls.find((c) => c.url.includes("/video_reels") && c.url.includes("upload_phase=finish"))!;
      expect(finish.url.startsWith(`${GRAPH_API_BASE}/PAGE/video_reels`)).toBe(true);
      expect(finish.url).toContain("video_id=v9");
      expect(finish.url).toContain("video_state=PUBLISHED");
      expect(finish.init?.method).toBe("POST");
    });
  });

  describe("FB photo: POST /{page}/photos", () => {
    it("posts to /{page}/photos on the configured version with url + published", async () => {
      installPublishFetch(() => Response.json({ post_id: "ph9" }));

      await metaProvider.publish({
        tokens,
        accountId: "PAGE",
        request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "c", options: { mediaKind: "image", published: false } },
        mediaUrls: ["https://cdn/x.jpg"],
        channelMetadata: { subKind: "facebook_page" },
      });

      const photo = calls.find((c) => c.url.includes("/photos"))!;
      expect(photo.url).toBe(`${GRAPH_API_BASE}/PAGE/photos`);
      expect(photo.init?.method).toBe("POST");
      const body = decodeURIComponent(bodyString(photo.init));
      expect(body).toContain("url=https://cdn/x.jpg");
      expect(body).toContain("published=false");
    });
  });

  describe("FB video: POST /{page}/videos", () => {
    it("posts to /{page}/videos on the configured version with file_url", async () => {
      installPublishFetch(() => Response.json({ id: "fbvid_9" }));

      await metaProvider.publish({
        tokens,
        accountId: "PAGE",
        request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "c", options: { target: "facebook" } },
        mediaUrls: ["https://cdn/x.mp4"],
      });

      const video = calls.find((c) => c.url.includes("/videos"))!;
      expect(video.url).toBe(`${GRAPH_API_BASE}/PAGE/videos`);
      expect(video.init?.method).toBe("POST");
      expect(decodeURIComponent(bodyString(video.init))).toContain("file_url=https://cdn/x.mp4");
    });
  });

  describe("IG container status poll: GET /{container}?fields=status_code", () => {
    it("polls the container on the configured version", async () => {
      installPublishFetch((url) => {
        if (url.includes("/media_publish")) return Response.json({ id: "ig_done" });
        if (url.includes("?fields=status_code")) return Response.json({ status_code: "FINISHED" });
        return Response.json({ id: "cont_poll" });
      });

      await metaProvider.publish({
        tokens,
        accountId: "IGID",
        request: { format: "reel", media: [{ mediaId: "m" }] },
        mediaUrls: ["https://cdn/x.mp4"],
        channelMetadata: { subKind: "instagram" },
      });

      const status = calls.find((c) => c.url.includes("?fields=status_code"))!;
      expect(status.url.startsWith(`${GRAPH_API_BASE}/cont_poll?fields=status_code`)).toBe(true);
      // status poll is a GET (no method / undefined)
      expect(status.init?.method ?? "GET").toBe("GET");
    });
  });

  describe("FB story: POST /{page}/photos (unpublished) → POST /{page}/photo_stories", () => {
    it("both story edges target the configured version", async () => {
      installPublishFetch((url) => {
        if (url.includes("/photo_stories")) return Response.json({ success: true, post_id: "fb_story_1" });
        return Response.json({ id: "photo_1" });
      });

      await metaProvider.publishStory!({
        tokens,
        accountId: "PAGE",
        mediaUrl: "https://cdn/card.jpg",
        channelMetadata: { subKind: "facebook_page" },
      });

      const photo = calls.find((c) => c.url.includes("/photos") && !c.url.includes("photo_stories"))!;
      expect(photo.url).toBe(`${GRAPH_API_BASE}/PAGE/photos`);
      const story = calls.find((c) => c.url.includes("/photo_stories"))!;
      expect(story.url).toBe(`${GRAPH_API_BASE}/PAGE/photo_stories`);
    });
  });

  // ─── Token introspection edges used by the managed connection ─────────────────────────────────────

  describe("debug_token: GET /debug_token uses GRAPH_API_BASE", () => {
    it("introspects with input_token + the app token (app_id|app_secret)", async () => {
      installPublishFetch(() =>
        Response.json({ data: { app_id: APP_ID, type: "USER", user_id: "42", is_valid: true } }),
      );

      await metaProvider.inspectSource!({ accessToken: "EAAG-master" });

      const call = calls.find((c) => c.url.includes("/debug_token"))!;
      expect(call.url.startsWith(`${GRAPH_API_BASE}/debug_token`)).toBe(true);
      expect(call.url).toContain("input_token=EAAG-master");
      // PSA10: introspect with THIS app's token, not the master token itself
      expect(call.url).toContain(`access_token=${encodeURIComponent(`${APP_ID}|test-app-secret`)}`);
    });
  });

  describe("me/accounts: GET /me/accounts uses GRAPH_API_BASE", () => {
    it("enumerates pages with the instagram_business_account field on the configured version", async () => {
      installPublishFetch(() =>
        Response.json({ data: [{ id: "p1", name: "Page", access_token: "PT1", instagram_business_account: { id: "ig1", username: "one" } }] }),
      );

      await metaProvider.enumerateSubAccounts!({ accessToken: "EAAG-master" });

      const call = calls.find((c) => c.url.includes("/me/accounts"))!;
      expect(call.url.startsWith(`${GRAPH_API_BASE}/me/accounts`)).toBe(true);
      expect(call.url).toContain("instagram_business_account");
    });
  });

  // ─── healthCheck (GET /me) also derives from GRAPH_API_BASE ───────────────────────────────────────

  describe("healthCheck: GET /me uses GRAPH_API_BASE", () => {
    it("requests the account identity on the configured version", async () => {
      installPublishFetch(() => Response.json({ id: "123", name: "Acct" }));

      await metaProvider.healthCheck(tokens);

      const call = calls.find((c) => c.url.includes("/me?"))!;
      expect(call.url.startsWith(`${GRAPH_API_BASE}/me?`)).toBe(true);
    });
  });
});
