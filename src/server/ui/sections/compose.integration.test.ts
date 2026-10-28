import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
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
    const ps = await db.query.posts.findMany({ where: eq(posts.content_id, id) });
    expect(ps).toHaveLength(2);
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
    const p = (await db.query.posts.findMany({ where: eq(posts.content_id, id) }))[0];
    expect(p.first_comment).toBe("👇 Comment LINK");
    expect(p.auto_story).toBe(true);
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
    const p = (await db.query.posts.findMany({ where: eq(posts.content_id, id) }))[0];
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
    expect((await db.query.posts.findMany({ where: eq(posts.content_id, id) }))).toHaveLength(1);
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

  it("persists TikTok choices from the composer", async () => {
    const payload = { brand: "techskills.academy", title: "TikTok choices", contentType: "video", mediaUrl: "https://cdn/reel.mp4",
      posts: [{ platform: "tiktok", tiktokPublishMode: "direct", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
        tiktokDisableComment: true, tiktokDisableDuet: false, tiktokDisableStitch: true,
        tiktokBrandContentToggle: true, tiktokBrandOrganicToggle: false }] };
    const res = await app.request("/compose", { method: "POST", headers: { cookie }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    expect(res.status).toBe(303);
    const id = res.headers.get("location")!.split("/").pop()!;
    const [post] = await db.query.posts.findMany({ where: eq(posts.content_id, id) });
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
    const [post] = await db.query.posts.findMany({ where: eq(posts.content_id, id) });
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
  tiktokScheduleText(): string;
  brand: string; title: string; type: string; mediaUrl: string; baseDescription: string; baseHashtags: string;
  publishMode: string; scheduleAt: string;
  sel: Record<string, { on: boolean; override: string }>;
  tt: { mode: string; privacy: string; disclosure: boolean; brandYourBrand: boolean; brandedContent: boolean;
    consent: boolean; consentKey: string; allowDuet: boolean; videoDurationSec: number };
  onBrandChange(): void; tiktokConsentKey(): string; canSubmit(): boolean;
  captionFor(platform: string): string; buildPayload(): { posts: Array<Record<string, unknown>>; publish: { at?: string } };
}
async function composeState(): Promise<ComposeState> {
  const out = await pageHtml();
  const inline = out.match(/<script>\s*function psCompose\(\)[\s\S]*?<\/script>/)![0].replace(/^<script>|<\/script>$/g, "");
  const embedded = (id: string) => ({ textContent: out.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`))![1] });
  return runInNewContext(readFileSync("src/server/ui/static/tiktok-panel.js", "utf8") +
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
