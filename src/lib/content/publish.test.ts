import { describe, it, expect } from "vitest";
import type { ResolvedDisclosure } from "@/lib/ai-disclosure/resolve";

// publish.ts transitively imports @/lib/db (validates env at module load); set a minimal env so the
// pure helpers under test can be imported. They never touch the DB.
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

const { buildCaption, deriveFormat, resolveFormat, postPublishOptions, disclosureOptions, prependDisclosureNote } = await import("./publish");

describe("buildCaption", () => {
  it("joins description + hashtags, trims, omits empties", () => {
    expect(buildCaption("hello", "#a #b")).toBe("hello\n\n#a #b");
    expect(buildCaption("  hi  ", null)).toBe("hi");
    expect(buildCaption(null, "#x")).toBe("#x");
    expect(buildCaption(null, null)).toBeUndefined();
    expect(buildCaption("", "  ")).toBeUndefined();
  });
});

describe("deriveFormat", () => {
  it("prefers an explicit override", () => {
    expect(deriveFormat({ contentType: "reel", override: "story", mediaUrl: "x.mp4" })).toBe("story");
  });
  it("uses content_type when present (short -> reel)", () => {
    expect(deriveFormat({ contentType: "reel", mediaUrl: "x.mp4" })).toBe("reel");
    expect(deriveFormat({ contentType: "short", mediaUrl: "x.mp4" })).toBe("reel");
    expect(deriveFormat({ contentType: "Post", mediaUrl: "x.jpg" })).toBe("post");
  });
  it("infers from the media URL when content_type is absent", () => {
    expect(deriveFormat({ mediaUrl: "https://cdn/x.mp4" })).toBe("reel");
    expect(deriveFormat({ mediaUrl: "https://cdn/x.jpg" })).toBe("image");
  });
});

describe("resolveFormat (per-platform)", () => {
  it("maps a video to each platform's format name", () => {
    expect(resolveFormat("instagram", "video", "x.mp4").format).toBe("reel");
    expect(resolveFormat("facebook", "video", "x.mp4").format).toBe("reel");
    expect(resolveFormat("youtube", "video", "x.mp4").format).toBe("short");
    expect(resolveFormat("tiktok", "video", "x.mp4").format).toBe("video");
    // X's RS platform value is "twitter" (not "x") — resolveFormat must key on the platform value that
    // actually reaches it, else a twitter video falls back to "reel" and the x provider rejects it.
    expect(resolveFormat("twitter", "video", "x.mp4").format).toBe("video");
    expect(resolveFormat("threads", "video", "x.mp4").format).toBe("video");
    expect(resolveFormat("linkedin", "video", "x.mp4").format).toBe("video");
  });
  it("maps an image to each platform's format name", () => {
    expect(resolveFormat("instagram", "image", "x.jpg").format).toBe("feed_post");
    expect(resolveFormat("twitter", "image", "x.jpg").format).toBe("image");
    expect(resolveFormat("linkedin", "image", "x.jpg").format).toBe("image");
  });
  it("infers kind from the URL, accepts legacy types, falls back for unknown platforms", () => {
    expect(resolveFormat("instagram", null, "x.mp4")).toEqual({ format: "reel", kind: "video" });
    expect(resolveFormat("youtube", "reel", "u").format).toBe("short"); // legacy 'reel' → video kind
    expect(resolveFormat("meta", "video", "x.mp4").format).toBe("reel"); // unknown platform → video fallback
  });
});

// YTOPTS1 + AIDISC1: the extra `options` a post's YouTube + AI-disclosure columns contribute to a
// publish request. The YouTube columns are all genuinely nullable, so a null there must contribute
// nothing — that's what keeps a legacy post (those columns null) byte-identical to the pre-YTOPTS1
// request shape. `ai_disclosure` is NOT NULL (defaults to 'none'), so it is never "absent" the same
// way — see the dedicated AI-disclosure tests below for what 'none' does on each kind of platform.
describe("postPublishOptions", () => {
  const blank = {
    youtube_privacy: null,
    youtube_tags: null,
    youtube_category_id: null,
    youtube_made_for_kids: null,
  };

  it("is an empty object when every source column is null", () => {
    expect(postPublishOptions(blank)).toEqual({});
  });

  it("carries each YouTube column through under its provider option name, omitting the rest", () => {
    expect(postPublishOptions({ ...blank, youtube_privacy: "unlisted" })).toEqual({ privacyStatus: "unlisted" });
    expect(postPublishOptions({ ...blank, youtube_tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
    expect(postPublishOptions({ ...blank, youtube_category_id: "22" })).toEqual({ categoryId: "22" });
    expect(postPublishOptions({ ...blank, youtube_made_for_kids: false })).toEqual({ madeForKids: false });
    expect(postPublishOptions({ ...blank, youtube_made_for_kids: true })).toEqual({ madeForKids: true });
  });

  it("ignores a non-array youtube_tags value (defensive against a corrupt jsonb column)", () => {
    expect(postPublishOptions({ ...blank, youtube_tags: "not-an-array" })).toEqual({});
  });

  it("combines multiple non-null YouTube columns into one options object", () => {
    expect(postPublishOptions({ ...blank, youtube_privacy: "public", youtube_category_id: "22" })).toEqual({
      privacyStatus: "public",
      categoryId: "22",
    });
  });
});

describe("disclosureOptions", () => {
  const resolved = (level: "none" | "ai_assisted" | "ai_generated", note: string | null = null): ResolvedDisclosure => ({
    level,
    levelSource: "post",
    note,
    noteSource: "post",
  });

  it("adds nothing at all when nothing was declared — the byte-identical regression guard", () => {
    // Every post that predates this feature resolves to `none`. Those must publish exactly as before:
    // no flag, and no audit object riding along in the payload either.
    for (const platform of ["youtube", "instagram", "tiktok", "x", "facebook", "threads", "linkedin"]) {
      expect(disclosureOptions(platform, resolved("none"))).toEqual({});
    }
  });

  it("carries the normalized flag when the platform has a native field", () => {
    expect(disclosureOptions("youtube", resolved("ai_generated"))).toMatchObject({ aiDisclosed: true });
    // YouTube's flag is scoped to realistic synthetic content — ai_assisted does not set it.
    expect(disclosureOptions("youtube", resolved("ai_assisted"))).toMatchObject({ aiDisclosed: false });
    expect(disclosureOptions("instagram", resolved("ai_assisted"))).toMatchObject({ aiDisclosed: true });
  });

  it("omits the flag for a platform with no native field, but still carries the audit object", () => {
    // LinkedIn cannot be told anything, yet the declaration still happened and the in-content note still
    // went out — the evidence has to survive for exactly the platforms with nothing else to show for it.
    const opts = disclosureOptions("linkedin", resolved("ai_generated", "Line."));
    expect(opts.aiDisclosed).toBeUndefined();
    expect(opts.aiDisclosure).toEqual({ level: "ai_generated", levelSource: "post", note: "Line.", noteSource: "post" });
  });

  it("carries where the declaration came from, so the audit trail can answer 'why did this disclose?'", () => {
    const opts = disclosureOptions("tiktok", { level: "ai_generated", levelSource: "brand", note: "B.", noteSource: "channel" } satisfies ResolvedDisclosure);
    expect(opts.aiDisclosure).toEqual({ level: "ai_generated", levelSource: "brand", note: "B.", noteSource: "channel" });
  });
});

describe("prependDisclosureNote", () => {
  it("returns the caption unchanged when there is no note", () => {
    expect(prependDisclosureNote("hello", null)).toBe("hello");
    expect(prependDisclosureNote(undefined, null)).toBeUndefined();
  });

  it("puts the note FIRST, so it survives the caption truncation platforms apply", () => {
    // Instagram/TikTok collapse long captions behind a "more" tap. A disclosure appended after the
    // hashtags is exactly the placement that would never be seen without interaction — which is the
    // one thing the Code of Practice says a label must not require.
    expect(prependDisclosureNote("hello", "Contains AI-generated content.")).toBe("Contains AI-generated content.\n\nhello");
  });

  it("never produces a stray blank line when the caption is absent — the note becomes the whole caption", () => {
    expect(prependDisclosureNote(undefined, "Contains AI-generated content.")).toBe("Contains AI-generated content.");
  });

  it("stays ahead of a full description+hashtags caption", () => {
    const caption = buildCaption("Body text", "#tag1 #tag2");
    expect(prependDisclosureNote(caption, "Created with AI assistance.")).toBe(
      "Created with AI assistance.\n\nBody text\n\n#tag1 #tag2",
    );
  });
});
