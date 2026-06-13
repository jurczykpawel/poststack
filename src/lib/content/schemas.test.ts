import { describe, it, expect } from "vitest";
import { contentCreate, postCreate, contentPatch } from "./schemas";

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
});
