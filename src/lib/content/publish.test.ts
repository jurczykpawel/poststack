import { describe, it, expect } from "vitest";

// publish.ts transitively imports @/lib/db (validates env at module load); set a minimal env so the
// pure helpers under test can be imported. They never touch the DB.
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

const { buildCaption, deriveFormat, resolveFormat } = await import("./publish");

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
    expect(resolveFormat("x", "video", "x.mp4").format).toBe("video");
    expect(resolveFormat("threads", "video", "x.mp4").format).toBe("video");
    expect(resolveFormat("linkedin", "video", "x.mp4").format).toBe("video");
  });
  it("maps an image to each platform's format name", () => {
    expect(resolveFormat("instagram", "image", "x.jpg").format).toBe("feed_post");
    expect(resolveFormat("x", "image", "x.jpg").format).toBe("image");
    expect(resolveFormat("linkedin", "image", "x.jpg").format).toBe("image");
  });
  it("infers kind from the URL, accepts legacy types, falls back for unknown platforms", () => {
    expect(resolveFormat("instagram", null, "x.mp4")).toEqual({ format: "reel", kind: "video" });
    expect(resolveFormat("youtube", "reel", "u").format).toBe("short"); // legacy 'reel' → video kind
    expect(resolveFormat("meta", "video", "x.mp4").format).toBe("reel"); // unknown platform → video fallback
  });
});
