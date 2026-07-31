import { describe, it, expect } from "vitest";
import { contentCreate, postCreate, postPatch, contentPatch } from "./schemas";

describe("content schemas", () => {
  it("requires a title on content create", () => {
    expect(contentCreate.safeParse({}).success).toBe(false);
    expect(contentCreate.safeParse({ title: "x" }).success).toBe(true);
  });

  it("validates ISO dates on the fields that carry them (postCreate.scheduledDate)", () => {
    expect(postCreate.safeParse({ platform: "instagram", scheduledDate: "not-a-date" }).success).toBe(false);
    expect(postCreate.safeParse({ platform: "instagram", scheduledDate: "2026-06-10T00:00:00Z" }).success).toBe(true);
  });

  it("strips system-managed lifecycle/provenance fields from the public create schemas [PSA8]", () => {
    const c = contentCreate.parse({ title: "x", status: "approved", approvedBy: "y", approvedAt: "2026-06-10T00:00:00Z" });
    expect("status" in c).toBe(false);
    expect("approvedBy" in c).toBe(false);
    const p = postCreate.parse({ platform: "instagram", status: "published", publishedUrl: "https://x", postizId: "z" });
    expect("status" in p).toBe(false);
    expect("publishedUrl" in p).toBe(false);
    expect("postizId" in p).toBe(false);
  });

  it("requires a platform on post create; contentId must be a uuid when given", () => {
    expect(postCreate.safeParse({}).success).toBe(false);
    expect(postCreate.safeParse({ platform: "instagram" }).success).toBe(true);
    expect(postCreate.safeParse({ platform: "instagram", contentId: "nope" }).success).toBe(false);
  });

  it("patch is fully partial", () => {
    expect(contentPatch.safeParse({}).success).toBe(true);
    expect(contentPatch.safeParse({ status: "approved" }).success).toBe(true);
  });

  it("accepts empty/null media URLs and preserves absent [APIFIX3]", () => {
    // "" is accepted (not rejected); it's normalized to null at the service layer, not here.
    expect(postCreate.safeParse({ platform: "instagram", videoUrl: "" }).success).toBe(true);
    // null is accepted so a PATCH can clear a URL.
    expect(postPatch.parse({ videoUrl: null }).videoUrl).toBeNull();
    // absent field stays absent (a PATCH must not clobber it).
    expect("videoUrl" in postPatch.parse({ coverUrl: "https://cdn/c.png" })).toBe(false);
  });

  it("accepts an optional post title, nullable so it can be cleared [APIFIX4]", () => {
    expect(postCreate.parse({ platform: "youtube", title: "Hello" }).title).toBe("Hello");
    expect(postPatch.parse({ title: null }).title).toBeNull();
    expect("title" in postPatch.parse({ platform: "youtube" })).toBe(false);
  });

  it("validates YouTube publish options [YTOPTS1]", () => {
    const base = { platform: "youtube" };
    expect(postCreate.safeParse({ ...base, youtubePrivacy: "unlisted" }).success).toBe(true);
    expect(postCreate.safeParse({ ...base, youtubePrivacy: "hidden" }).success).toBe(false);
    // nullish so a PATCH can clear it
    expect(postPatch.parse({ youtubePrivacy: null }).youtubePrivacy).toBeNull();

    expect(postCreate.safeParse({ ...base, youtubeTags: ["a", "b"] }).success).toBe(true);
    expect(postCreate.safeParse({ ...base, youtubeTags: [""] }).success).toBe(false); // no empty tags
    expect(postCreate.safeParse({ ...base, youtubeTags: Array(51).fill("x") }).success).toBe(false); // cap 50
    // total combined length over YouTube's 500-char limit
    const tooLong = { ...base, youtubeTags: ["x".repeat(250), "y".repeat(251)] };
    expect(postCreate.safeParse(tooLong).success).toBe(false);
    const justUnder = { ...base, youtubeTags: ["x".repeat(250), "y".repeat(250)] };
    expect(postCreate.safeParse(justUnder).success).toBe(true);

    expect(postCreate.safeParse({ ...base, youtubeCategoryId: "22" }).success).toBe(true);
    expect(postCreate.safeParse({ ...base, youtubeCategoryId: "not-a-number" }).success).toBe(false);
    expect(postCreate.safeParse({ ...base, youtubeCategoryId: "12345678901" }).success).toBe(false); // > max 10

    expect(postCreate.safeParse({ ...base, youtubeMadeForKids: true }).success).toBe(true);
    expect(postPatch.parse({ youtubeMadeForKids: null }).youtubeMadeForKids).toBeNull();
  });

  it("validates AI disclosure fields [AIDISC1]", () => {
    const base = { platform: "youtube" };
    expect(postCreate.safeParse({ ...base, aiDisclosure: "ai_generated" }).success).toBe(true);
    expect(postCreate.safeParse({ ...base, aiDisclosure: "fully_synthetic" }).success).toBe(false);
    expect(postCreate.safeParse({ ...base, aiDisclosureNote: "Made with AI." }).success).toBe(true);
    expect(postPatch.parse({ aiDisclosureNote: null }).aiDisclosureNote).toBeNull();
    expect(postCreate.safeParse({ ...base, aiDisclosureNote: "x".repeat(300) }).success).toBe(false); // > LIMITS.line
  });

  it("never accepts ai_disclosure_sent from the public body — engine-written audit trail [AIDISC1]", () => {
    const parsed = postCreate.parse({ platform: "youtube", ai_disclosure_sent: { youtube: true } } as never);
    expect("ai_disclosure_sent" in parsed).toBe(false);
    expect("aiDisclosureSent" in parsed).toBe(false);
  });
});
