import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces, channels, brands, content, posts, rateLimitCounters, sequences, auditLogs, media, deliveries } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const creatorInfo = {
  creator_nickname: "Creator TT3", creator_avatar_url: "", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  comment_disabled: true, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 60,
};
const mediaBytes = "tt3-video-fixture";
vi.mock("@/lib/media/ssrf", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/media/ssrf")>(),
  safeFetch: vi.fn(async () => new Response("tt3-video-fixture", { headers: { "content-type": "video/mp4" } })),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "compose-ui@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/session=[^;]+/);
  return m ? m[0] : "";
}

beforeAll(async () => {
  if (!TEST_DB) return;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/creator_info/query/") {
      const token = new Headers(init?.headers).get("Authorization");
      return Response.json(token?.includes("cannot-post")
        ? { error: { code: "spam_risk_too_many_posts" } }
        : { data: creatorInfo, error: { code: "ok" } });
    }
    throw new Error("HTTP unavailable in this test");
  }));
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.REGISTRATION_ENABLED = "true";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../../app");
  app = buildApp();
  await licenseInstance(); // all-access (publishing entitled)

  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) {
    await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  }
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(rateLimitCounters); // the register rate-limit is DB-backed + shared across files
  await db.delete(workspaces); // single-tenant test — clear leftover workspaces so register isn't multitenant-locked (pro lacks multi_workspace)
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = cookieFrom(res);
  const user = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true }, limit: 1 } },
  });
  workspaceId = user!.workspaceMembers[0].workspace_id;

  // A brand with an Instagram + YouTube channel so the compose page lists those platforms.
  await db.insert(brands).values({ workspace_id: workspaceId, key: "techskills.academy", name: "Tech Skills Academy" });
  await db.insert(channels).values([
    { workspace_id: workspaceId, platform: "instagram", platform_id: "ig1", display_name: "@tsa", brand_key: "techskills.academy", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w1", status: "active" },
    { workspace_id: workspaceId, platform: "youtube", platform_id: "UC1", display_name: "TSA YT", brand_key: "techskills.academy", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w2", status: "active" },
    { workspace_id: workspaceId, platform: "tiktok", platform_id: "tt3", display_name: "TT3", brand_key: "techskills.academy", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w3", status: "active" },
  ]);
  await db.insert(media).values({ workspace_id: workspaceId, checksum: createHash("sha256").update(mediaBytes).digest("hex"), storage_key: "tt3.mp4", url: "https://cdn.example.test/tt3.mp4", kind: "video", mime: "video/mp4", size: mediaBytes.length, duration_sec: 30, width: 1080, height: 1920, status: "ready" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  if (closeQueue) await closeQueue();
  await db.$client.end();
  vi.unstubAllGlobals();
});

describe("unified Compose section", () => {
  it("keeps the schedule warning with the sticky publish controls", async () => {
    if (!TEST_DB) return;
    const out = await (await app.request("/compose", { headers: { cookie } })).text();
    const controls = out.slice(out.indexOf('<div class="compose-pubbar"'), out.indexOf('</form>', out.indexOf('<div class="compose-pubbar"')));
    expect(controls).toContain('x-text="scheduleNotice"');
  });

  it("explains how to assign channels for an empty brand", async () => {
    if (!TEST_DB) return;
    await db.insert(brands).values({ workspace_id: workspaceId, key: "empty", name: "Empty brand" });
    const out = await (await app.request("/compose", { headers: { cookie } })).text();
    expect(out).toContain('x-show="brand &amp;&amp; availPlatforms.length === 0"');
    expect(out).toContain('This brand has no channels');
    expect(out).toContain('href="/brands"');
  });

  it("renders a labeled media URL and stacks media fields on narrow screens", async () => {
    if (!TEST_DB) return;
    const out = await (await app.request("/compose", { headers: { cookie } })).text();
    expect(out).toMatch(/<label class="fld grow"><span>Media URL<\/span><input type="url"/);
    const css = readFileSync("src/server/ui/static/admin.css", "utf8");
    expect(css).toMatch(/@media \(max-width: 600px\)\s*\{\s*\.media-row, \.media-fields \.fld-row\s*\{[^}]*flex-direction: column/);
    expect(css).toMatch(/\.media-fields \.fld-row \.fld\s*\{[^}]*flex: 1 1 auto/);
  });

  it("redirects to login without a session", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/compose")).status).toBe(302);
  });

  it("renders the authoring page with the Alpine component + embedded brand data", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/compose", { headers: { cookie } });
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).toContain("psCompose(");
    expect(out).toContain("ps-compose-data");
    expect(out).toContain("Create &"); // primary action
    expect(out).toContain("Tech Skills Academy"); // brand embedded
    expect(out).toContain('<option value="techskills.academy">Tech Skills Academy</option>');
    expect(out).toContain("instagram"); // available platform embedded
  });

  it("POST creates a draft content + planned posts and redirects to the cockpit", async () => {
    if (!TEST_DB) return;
    const payload = {
      brand: "techskills.academy",
      title: "AI w terminalu",
      contentType: "reel",
      mediaUrl: "https://cdn/reel.mp4",
      coverUrl: "https://cdn/cover.png",
      baseDescription: "Base caption",
      baseHashtags: "#ai",
      language: "pl",
      posts: [{ platform: "instagram" }, { platform: "youtube", description: "YT caption" }],
    };
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/^\/content\/[0-9a-f-]+$/);

    const id = loc.split("/").pop()!;
    const row = await db.query.content.findFirst({ where: eq(content.id, id) });
    expect(row!.status).toBe("draft");
    expect(row!.profile).toBe("techskills.academy");
    const ps = await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) });
    expect(ps).toHaveLength(2);
    expect(ps.every(p => p.language === "pl")).toBe(true);
    expect(ps.every((p) => p.status === "planned")).toBe(true);
    expect(ps.find((p) => p.platform === "youtube")!.description).toBe("YT caption");
    expect(ps.find((p) => p.platform === "instagram")!.description).toBe("Base caption");
    expect(ps.every((p) => p.video_url === "https://cdn/reel.mp4")).toBe(true);
  });

  it("renders the per-platform Automation section (first comment, auto-story, auto-reply)", async () => {
    if (!TEST_DB) return;
    const out = await (await app.request("/compose", { headers: { cookie } })).text();
    expect(out).toContain("Automation");
    expect(out).toContain("First comment");
    expect(out).toContain("Auto-Story");
    expect(out).toContain("Comment → DM");
  });

  it("POST persists per-post automation (first_comment, auto_story, auto_reply) onto the posts", async () => {
    if (!TEST_DB) return;
    const payload = {
      brand: "techskills.academy",
      title: "Automation post",
      contentType: "reel",
      mediaUrl: "https://cdn/reel.mp4",
      baseDescription: "Base",
      posts: [
        {
          platform: "instagram",
          firstComment: "👇 Comment LINK",
          autoStory: true,
          autoStoryMode: "media",
          autoReply: { keywords: [{ value: "LINK", matchType: "contains" }], dmText: "Here you go!", replyMode: "dm" },
        },
      ],
    };
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    expect(res.status).toBe(303);
    const id = res.headers.get("location")!.split("/").pop()!;
    const p = (await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) }))[0];
    expect(p.first_comment).toBe("👇 Comment LINK");
    expect(p.auto_story).toBe(true);
    expect(p.auto_story_mode).toBe("media");
    expect((p.auto_reply as { dmText?: string } | null)?.dmText).toBe("Here you go!");
  });

  // SEQTRIGGER1: an auto-reply can enroll the commenter into a drip sequence.
  it("offers the sequence enroll option and persists a sequence auto_reply", async () => {
    if (!TEST_DB) return;
    const [seq] = await db.insert(sequences)
      .values({ workspace_id: workspaceId, name: "Welcome drip", status: "active", steps: [{ type: "message", content: "hi" }] })
      .returning({ id: sequences.id });

    // The compose page advertises the enroll option + the active sequence in its embedded JSON.
    const out = await (await app.request("/compose", { headers: { cookie } })).text();
    expect(out).toContain("Enroll in a sequence");
    expect(out).toContain("Welcome drip");

    const payload = {
      brand: "techskills.academy",
      title: "Sequence enroll post",
      contentType: "reel",
      mediaUrl: "https://cdn/reel.mp4",
      posts: [
        { platform: "instagram", autoReply: { keywords: [{ value: "KURS", matchType: "contains" }], responseType: "sequence", sequenceId: seq!.id } },
      ],
    };
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    expect(res.status).toBe(303);
    const id = res.headers.get("location")!.split("/").pop()!;
    const p = (await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) }))[0];
    const ar = p.auto_reply as { responseType?: string; sequenceId?: string } | null;
    expect(ar?.responseType).toBe("sequence");
    expect(ar?.sequenceId).toBe(seq!.id);
  });

  it("renders the Publish section (draft / now / schedule)", async () => {
    if (!TEST_DB) return;
    const out = await (await app.request("/compose", { headers: { cookie } })).text();
    expect(out).toContain(">Draft<");
    expect(out).toContain("Publish now");
    expect(out).toContain("Schedule");
  });

  it("POST with publish.mode=now still creates the draft + redirects (publish attempted best-effort)", async () => {
    if (!TEST_DB) return;
    const payload = {
      brand: "techskills.academy",
      title: "Publish-from-compose",
      contentType: "reel",
      mediaUrl: "https://cdn/reel.mp4",
      baseDescription: "Base",
      posts: [{ platform: "instagram" }],
      publish: { mode: "now" },
    };
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/content\/[0-9a-f-]+$/);
    const id = res.headers.get("location")!.split("/").pop()!;
    expect((await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) }))).toHaveLength(1);
  });

  it("rejects a malformed payload with 400", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify({ title: "x" }) }),
    });
    expect(res.status).toBe(400);
  });
});

const pageHtml = async () => (await app.request("/compose", { headers: { cookie } })).text();
describe("TikTok Compose controls", () => {
  it.each([
    ["creator nickname at render", "Creator TT3"],
    ["privacy from creator info", 'x-for="opt in tt.privacyOptionsView"'],
    ["privacy placeholder", "Select who can view"],
    ["comment control", 'x-model="tt.allowComment"'],
    ["duet control", 'x-model="tt.allowDuet"'],
    ["stitch control", 'x-model="tt.allowStitch"'],
    ["interaction explanation", "TikTok account settings"],
    ["commercial disclosure", 'x-model="tt.disclosure"'],
    ["your brand", "Your brand"],
    ["branded content", "Branded content"],
    ["private visibility explanation", "Branded content visibility cannot be set to private"],
    ["music consent", "Music Usage Confirmation"],
    ["branded policy", "Branded Content Policy"],
    ["explicit consent", "I confirm this TikTok submission"],
    ["processing notice", "Processing may take a few minutes"],
    ["playable preview", 'aria-label="TikTok video preview"'],
    ["editable caption", 'aria-label="TikTok caption"'],
    ["automatic schedule disclosure", "Opublikujemy automatycznie"],
  ])("renders %s", async (_rule, expected) => {
    expect(await pageHtml()).toContain(expected);
  });

  it.each([
    ["visibility", 'aria-label="YouTube visibility"'],
    ["category", 'aria-label="YouTube category"'],
    ["made for kids without a default", '<option value="">Select…</option><option value="no">'],
    ["license", 'aria-label="YouTube license"'],
    ["chapters editor", "yt.addChapter()"],
    ["translations editor", "yt.addLocalization()"],
    ["age restriction pointer to Studio", "Age restriction, playlists and subtitles"],
  ])("renders the YouTube %s control", async (_rule, expected) => {
    expect(await pageHtml()).toContain(expected);
  });

  it("persists YouTube chapters and film fields from the composer", async () => {
    const payload = { brand: "techskills.academy", title: "Film", contentType: "video", mediaUrl: "https://cdn/film.mp4",
      posts: [{ platform: "youtube", youtubePrivacy: "unlisted", youtubeMadeForKids: false, youtubeLicense: "creativeCommon",
        youtubeEmbeddable: false, youtubeNotifySubscribers: false, youtubeDefaultLanguage: "pl", youtubeRecordingDate: "2026-10-01T00:00:00.000Z",
        youtubeChapters: [{ start: "00:00", title: "A" }, { start: "00:30", title: "B" }, { start: "1:30", title: "C" }],
        youtubeLocalizations: { en: { title: "Film EN" } } }] };
    const res = await app.request("/compose", { method: "POST", headers: { cookie }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    expect(res.status).toBe(303);
    const id = res.headers.get("location")!.split("/").pop()!;
    const [post] = await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) });
    expect(post).toMatchObject({ youtube_privacy: "unlisted", youtube_made_for_kids: false, youtube_license: "creativeCommon",
      youtube_embeddable: false, youtube_notify_subscribers: false, youtube_default_language: "pl",
      youtube_chapters: [{ start: 0, title: "A" }, { start: 30, title: "B" }, { start: 90, title: "C" }],
      youtube_localizations: { en: { title: "Film EN" } } });
    expect(post!.youtube_recording_date?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rejects chapters YouTube would ignore", async () => {
    const payload = { brand: "techskills.academy", title: "Film", contentType: "video", mediaUrl: "https://cdn/film.mp4",
      posts: [{ platform: "youtube", youtubeChapters: [{ start: "00:00", title: "A" }, { start: "00:30", title: "B" }] }] };
    const res = await app.request("/compose", { method: "POST", headers: { cookie }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    expect(res.status).toBe(400);
  });

  it("persists TikTok choices from the composer", async () => {
    const payload = { brand: "techskills.academy", title: "TikTok choices", contentType: "video", mediaUrl: "https://cdn/reel.mp4",
      posts: [{ platform: "tiktok", tiktokPublishMode: "direct", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
        tiktokDisableComment: true, tiktokDisableDuet: false, tiktokDisableStitch: true,
        tiktokBrandContentToggle: true, tiktokBrandOrganicToggle: false }] };
    const res = await app.request("/compose", { method: "POST", headers: { cookie }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    expect(res.status).toBe(303);
    const id = res.headers.get("location")!.split("/").pop()!;
    const [post] = await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) });
    expect(post).toMatchObject({ tiktok_publish_mode: "direct", tiktok_privacy_level: "PUBLIC_TO_EVERYONE",
      tiktok_disable_comment: true, tiktok_disable_duet: false, tiktok_disable_stitch: true,
      tiktok_brand_content_toggle: true, tiktok_brand_organic_toggle: false });
  });

  it.each(["now", "schedule"])("requires explicit consent for %s", async (mode) => {
    const payload = { brand: "techskills.academy", title: "No consent", mediaUrl: "https://cdn/reel.mp4",
      posts: [{ platform: "tiktok", tiktokPublishMode: "direct", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE" }],
      publish: { mode, at: new Date(Date.now() + 3600000).toISOString() } };
    const res = await app.request("/compose", { method: "POST", headers: { cookie }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    expect(res.status).toBe(400);
  });
});

describe("TikTok Compose submission", () => {
  async function payload() {
    const channel = await db.query.channels.findFirst({ where: eq(channels.platform_id, "tt3") });
    return { brand: "techskills.academy", title: "Confirmed TikTok", contentType: "video", mediaUrl: "https://cdn.example.test/tt3.mp4",
      baseDescription: "Caption", posts: [{ platform: "tiktok", tiktokPublishMode: "direct", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
        tiktokDisableComment: true, tiktokDisableDuet: false, tiktokDisableStitch: true, tiktokBrandContentToggle: false,
        tiktokBrandOrganicToggle: true, tiktokConsent: true, tiktokChannelId: channel!.id, tiktokDisclosure: true }],
      publish: { mode: "schedule", at: new Date(Date.now() + 86400000).toISOString() } };
  }
  async function submit(p: unknown) {
    return app.request("/compose", { method: "POST", headers: { cookie }, body: new URLSearchParams({ payload: JSON.stringify(p) }) });
  }
  it.each(["now", "schedule"])("captures settings and explicit consent for %s", async (mode) => {
    const p = await payload(); p.publish.mode = mode;
    const res = await submit(p); expect(res.status).toBe(303);
    const id = res.headers.get("location")!.split("/").pop()!;
    const [post] = await db.query.posts.findMany({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) });
    expect(post.tiktok_brand_organic_toggle).toBe(true);
    expect(post.status).toBe("scheduled");
    if (mode === "schedule") expect(post.scheduled_date!.toISOString()).toBe(p.publish.at);
    const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, post.delivery_id!) });
    expect(delivery!.payload).toMatchObject({ caption: "Caption", options: { publishMode: "direct", privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: true, disableDuet: false, disableStitch: true, brandOrganicToggle: true } });
    const audit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.target_id, id) });
    expect(audit).toMatchObject({ action: "tiktok.submission_confirmed", actor_id: expect.any(String), metadata: { mode, channelId: p.posts[0].tiktokChannelId } });
  });
  it.each(["privacy", "branded-private", "interactions", "disclosure", "channel", "past"])("rejects invalid %s before creating content", async (rule) => {
    const p = await payload();
    if (rule === "privacy") p.posts[0].tiktokPrivacyLevel = "FOLLOWER_OF_CREATOR";
    if (rule === "branded-private") { p.posts[0].tiktokPrivacyLevel = "SELF_ONLY"; p.posts[0].tiktokBrandContentToggle = true; }
    if (rule === "interactions") p.posts[0].tiktokDisableComment = false;
    if (rule === "disclosure") p.posts[0].tiktokBrandOrganicToggle = false;
    if (rule === "channel") p.posts[0].tiktokChannelId = "00000000-0000-4000-8000-000000000000";
    if (rule === "past") p.publish.at = "2000-01-01T00:00:00Z";
    expect((await submit(p)).status).toBe(400);
  });
  it.each(["direct", "inbox"])("shows cannot-post guidance and rejects %s when the creator cannot post", async (mode) => {
    const p = await payload();
    p.posts[0].tiktokPublishMode = mode;
    await db.update(channels).set({ token_encrypted: encryptTokens({ access_token: "cannot-post" }) }).where(eq(channels.id, p.posts[0].tiktokChannelId));
    try {
      expect(await pageHtml()).toContain('"status":"cannot_post_now"');
      const res = await submit(p); expect(res.status).toBe(400); expect(await res.text()).toContain("Try again later");
    } finally {
      await db.update(channels).set({ token_encrypted: encryptTokens({ access_token: "available-again" }) }).where(eq(channels.id, p.posts[0].tiktokChannelId));
    }
  });
});

it("visually distinguishes unavailable TikTok interactions", () => {
  const css = readFileSync("src/server/ui/static/admin.css", "utf8");
  expect(css).toContain(".tiktok-panel .compose-toggle:has(input:disabled)");
});

interface ComposeState {
  extraMedia: string[]; mediaKinds: Record<string, string>;
  allMedia(): string[]; moveMedia(index: number, step: number): void;
  mediaImage(url: string): boolean; mediaVideo(url: string): boolean;
  tiktokScheduleText(): string;
  brand: string; title: string; type: string; mediaUrl: string; baseDescription: string; baseHashtags: string;
  publishMode: string; scheduleAt: string; language: string;
  sel: Record<string, { on: boolean; override: string }>;
  tt: { mode: string; privacy: string; disclosure: boolean; brandYourBrand: boolean; brandedContent: boolean;
    consent: boolean; consentKey: string; allowDuet: boolean; videoDurationSec: number };
  onBrandChange(): void; tiktokConsentKey(): string; canSubmit(): boolean;
  captionFor(platform: string): string; buildPayload(): { language?: string; posts: Array<Record<string, unknown>>; publish: { at?: string } };
}
async function composeState(): Promise<ComposeState> {
  const out = await pageHtml();
  const inline = out.match(/<script>\s*function psCompose\(\)[\s\S]*?<\/script>/)![0].replace(/^<script>|<\/script>$/g, "");
  const embedded = (id: string) => ({ textContent: out.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`))![1] });
  return runInNewContext(readFileSync("src/server/ui/static/tiktok-panel.js", "utf8") + readFileSync("src/server/ui/static/youtube-panel.js", "utf8") +
    readFileSync("src/server/ui/static/schedule-time.js", "utf8") + inline + "; psCompose()", {
      window: {}, document: { getElementById: embedded, querySelectorAll: () => [], addEventListener: () => {} },
    }) as ComposeState;
}

it("builds the confirmed TikTok payload and requires confirmation again after a change", async () => {
  const c = await composeState();
  c.brand = "techskills.academy"; c.onBrandChange();
  c.sel.instagram.on = c.sel.youtube.on = false;
  c.title = "Reviewed"; c.mediaUrl = "https://cdn.example.test/tt3.mp4";
  c.baseDescription = "Base caption"; c.baseHashtags = " #video "; c.sel.tiktok.override = " Final caption ";
  c.tt.mode = "direct"; c.publishMode = "schedule"; c.scheduleAt = "2030-01-15T14:30";
  expect(c.canSubmit()).toBe(false);
  c.tt.privacy = "PUBLIC_TO_EVERYONE";
  c.tt.disclosure = c.tt.brandYourBrand = c.tt.allowDuet = true;
  expect(c.canSubmit()).toBe(false);
  c.tt.consent = true; c.tt.consentKey = c.tiktokConsentKey();
  expect(c.canSubmit()).toBe(true);
  expect(c.captionFor("tiktok")).toBe("Final caption\n\n#video");
  const body = c.buildPayload();
  expect(body.posts).toHaveLength(1);
  expect(body.posts[0]).toMatchObject({ platform: "tiktok", description: "Final caption", tiktokPublishMode: "direct", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE", tiktokDisableComment: true, tiktokDisableDuet: false, tiktokDisableStitch: true, tiktokBrandOrganicToggle: true, tiktokBrandContentToggle: false, tiktokConsent: true, tiktokChannelId: expect.any(String) });
  expect(body.publish.at).toBe(new Date(c.scheduleAt).toISOString());
  c.scheduleAt = "2030-01-15T15:30"; expect(c.canSubmit()).toBe(false);
  c.tt.consentKey = c.tiktokConsentKey(); expect(c.canSubmit()).toBe(true);
  c.sel.tiktok.override = "Changed caption"; expect(c.canSubmit()).toBe(false);
  c.tt.consentKey = c.tiktokConsentKey(); expect(c.canSubmit()).toBe(true);
  c.tt.videoDurationSec = 61; expect(c.canSubmit()).toBe(false);
});

it("shows that scheduled TikTok will require send-time confirmation when enabled", async () => {
  const { setConfig, clearConfig } = await import("@/lib/settings/config");
  await setConfig("TIKTOK_CONFIRM_AT_SEND", "true");
  try {
    const c = await composeState();
    c.scheduleAt = "2030-01-15T14:30";
    expect(c.tiktokScheduleText()).toContain("wymaga potwierdzenia");
    expect(c.tiktokScheduleText()).not.toContain("Opublikujemy automatycznie");
  } finally { await clearConfig("TIKTOK_CONFIRM_AT_SEND"); }
});

it.each([1, 11])("rejects a Compose carousel with %s slides before authoring", async count => {
  const response = await app.request("/compose", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify({ brand: "techskills.academy", title: "Invalid carousel", contentType: "carousel", mediaUrl: "https://cdn.example.test/tt3.mp4", mediaUrls: Array(count).fill("https://cdn.example.test/tt3.mp4"), posts: [{ platform: "instagram" }] }) }) });
  expect(response.status).toBe(422);
  expect(await response.text()).toContain(count === 1 ? "format &#39;carousel&#39; needs &gt;= 2 media" : "format &#39;carousel&#39; allows &lt;= 10 media");
});

it("rejects unsupported Compose carousel destinations without creating content", async () => {
  const before = await db.select().from(content).where(eq(content.workspace_id, workspaceId));
  const response = await app.request("/compose", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify({ brand: "techskills.academy", title: "Unsupported carousel", mediaUrl: "https://cdn.example.test/tt3.mp4", mediaUrls: Array(2).fill("https://cdn.example.test/tt3.mp4"), posts: [{ platform: "tiktok" }] }) }) });
  expect(response.status).toBe(422);
  expect(await response.text()).toContain("unsupported format");
  expect(await db.select().from(content).where(eq(content.workspace_id, workspaceId))).toHaveLength(before.length);
});

it("lists only ready workspace media for the Compose library", async () => {
  const [other] = await db.insert(workspaces).values({ name: "Other library", slug: "other-compose-library" }).returning();
  const [pending] = await db.insert(media).values({ workspace_id: workspaceId, checksum: "compose-library-pending", storage_key: "", url: "", kind: "", status: "ingesting" }).returning();
  try {
    await db.insert(media).values({ workspace_id: other.id, checksum: "compose-library-other", storage_key: "other.png", url: "https://cdn.example.test/other.png", kind: "image" });
    const ready = await db.query.media.findFirst({ where: and(eq(media.workspace_id, workspaceId), eq(media.url, "https://cdn.example.test/tt3.mp4")) });
    await db.update(media).set({ status: "ready", canonical_id: ready!.id }).where(and(eq(media.workspace_id, workspaceId), eq(media.id, pending.id)));
    const response = await app.request("/api/v1/media", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.some((m: { url: string }) => m.url === "https://cdn.example.test/tt3.mp4")).toBe(true);
    expect(body.data.some((m: { url: string }) => m.url === "https://cdn.example.test/other.png")).toBe(false);
    expect(body.data.every((m: { kind: string }) => ["image", "video"].includes(m.kind))).toBe(true);
  } finally {
    await db.delete(media).where(and(eq(media.workspace_id, workspaceId), eq(media.id, pending.id)));
    await db.delete(workspaces).where(eq(workspaces.id, other.id));
  }
});

it("checks the Facebook channel permission before authoring a mixed carousel", async () => {
  await db.insert(channels).values({ workspace_id: workspaceId, platform: "facebook", platform_id: "compose-fb", brand_key: "techskills.academy", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w" });
  const response = await app.request("/compose", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify({ brand: "techskills.academy", title: "Mixed carousel", mediaUrl: "https://cdn.example.test/tt3.mp4", mediaUrls: Array(2).fill("https://cdn.example.test/tt3.mp4"), posts: [{ platform: "facebook" }] }) }) });
  expect(response.status).toBe(422);
  expect(await response.text()).toContain("Video in Facebook carousels requires a verified Meta app with ads permission (pages_manage_ads) for this Page.");
});

it("keeps the complete ordered draft when a carousel URL is invalid", async () => {
  const mediaUrls = ["https://cdn.example.test/a.png", "file:///slide.png", "https://cdn.example.test/c.png"];
  const response = await app.request("/compose", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify({ brand: "techskills.academy", title: "Retained carousel", mediaUrl: mediaUrls[0], mediaUrls, posts: [{ platform: "instagram" }] }) }) });
  expect(response.status).toBe(422);
  const out = await response.text();
  const draft = JSON.parse(out.match(/<script id="ps-compose-draft"[^>]*>([\s\S]*?)<\/script>/)![1]);
  expect(draft.mediaUrls).toEqual(mediaUrls);
});

it("authors a video carousel for an eligible Facebook channel with ordered mediaUrls", async () => {
  await db.update(channels).set({ video_carousel: "available" }).where(and(eq(channels.workspace_id, workspaceId), eq(channels.platform_id, "compose-fb")));
  const urls = ["https://cdn.example.test/tt3.mp4", "https://cdn.example.test/tt3.mp4"];
  try {
    const response = await app.request("/compose", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify({ brand: "techskills.academy", title: "Eligible carousel", mediaUrl: urls[0], mediaUrls: urls, posts: [{ platform: "facebook" }] }) }) });
    expect(response.status).toBe(303);
    const id = response.headers.get("location")!.split("/").pop()!;
    const saved = await db.query.posts.findFirst({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.content_id, id)) });
    expect(saved?.media_urls).toEqual(urls);
  } finally {
    await db.update(channels).set({ video_carousel: "unknown" }).where(and(eq(channels.workspace_id, workspaceId), eq(channels.platform_id, "compose-fb")));
  }
});

it("uploads a probed image into the Compose library and reuses its stored reference", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const upload = () => app.request("/api/v1/media", { method: "POST", headers: { cookie, "content-type": "image/png" }, body: bytes });
  const first = await upload();
  expect(first.status).toBe(201);
  const stored = (await first.json()).data;
  expect(stored).toMatchObject({ kind: "image", status: "ready", workspaceId });
  expect(stored.url).toMatch(/^https?:\/\//);
  const second = await upload();
  expect(second.status).toBe(201);
  expect((await second.json()).data.id).toBe(stored.id);
});

it("rejects unrecognized Compose uploads without adding library entries", async () => {
  const before = await db.select().from(media).where(eq(media.workspace_id, workspaceId));
  const response = await app.request("/api/v1/media", { method: "POST", headers: { cookie, "content-type": "image/png" }, body: "not an image" });
  expect(response.status).toBe(400);
  expect(await db.select().from(media).where(eq(media.workspace_id, workspaceId))).toHaveLength(before.length);
});

it("previews registered media by kind and keeps the moved slide order", async () => {
  const c = await composeState();
  const video = "https://cdn.example.test/video.png", image = "https://cdn.example.test/image.mp4";
  c.mediaKinds[video] = "video"; c.mediaKinds[image] = "image";
  expect(c.mediaImage(video)).toBe(false); expect(c.mediaVideo(video)).toBe(true);
  expect(c.mediaImage(image)).toBe(true); expect(c.mediaVideo(image)).toBe(false);
  c.mediaUrl = image; c.extraMedia = [video, "https://cdn.example.test/third.png"];
  c.moveMedia(2, -1);
  expect(Array.from(c.allMedia())).toEqual([image, "https://cdn.example.test/third.png", video]);
});

it("offers Story and article formats with an article URL field", async () => {
  const out = await (await app.request("/compose", { headers: { cookie } })).text();
  expect(out).toContain('<option value="story">');
  expect(out).toContain('<option value="article">');
  expect(out).toContain('x-model="articleUrl"');
});

it("includes the selected language in the browser payload", async () => {
  const c = await composeState();
  expect(c.language).toBe("");
  c.language = "pl";
  expect(c.buildPayload().language).toBe("pl");
  c.language = "";
  expect(c.buildPayload().language).toBeUndefined();
});
