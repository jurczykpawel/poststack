import { describe, it, expect } from "vitest";
import { disclosureForPlatform, disclosureFlag, requiresInContentNote } from "@/lib/ai-disclosure/mapping";

const WITH_FIELD = ["youtube", "instagram", "tiktok", "x"] as const;
const WITHOUT_FIELD = ["facebook", "threads", "linkedin"] as const;

describe("disclosureForPlatform — native field names", () => {
  // These four strings are the vendor's own field paths (verified 2026-07-31). If a rename ever lands
  // here without the provider being updated too, this test is the tripwire.
  it.each([
    ["youtube", "status.containsSyntheticMedia"],
    ["instagram", "is_ai_generated"],
    ["tiktok", "post_info.is_aigc"],
    ["x", "made_with_ai"],
    ["twitter", "made_with_ai"],
  ])("%s → %s", (platform, field) => {
    expect(disclosureForPlatform(platform, "ai_generated").field).toBe(field);
  });
});

describe("disclosureForPlatform — level semantics", () => {
  it("ai_generated sets the flag on every platform that has one", () => {
    for (const p of WITH_FIELD) {
      expect(disclosureForPlatform(p, "ai_generated")).toMatchObject({ supported: true, value: true });
    }
  });

  it("ai_assisted sets the flag everywhere EXCEPT YouTube", () => {
    // YouTube scopes its flag to realistic altered/synthetic content and states production assistance
    // needs no disclosure — flagging there would add a label the platform itself says is unneeded.
    expect(disclosureForPlatform("youtube", "ai_assisted")).toMatchObject({ supported: true, value: false });
    for (const p of ["instagram", "tiktok", "x"] as const) {
      expect(disclosureForPlatform(p, "ai_assisted")).toMatchObject({ supported: true, value: true });
    }
  });

  it("none sends nothing at all rather than an explicit false", () => {
    // `none` is also what a post with nothing declared resolves to (resolve.ts), so it covers "nobody said"
    // as well as "the operator declared no AI". Sending `false` would assert a negative the operator may
    // never have made — and on AI content someone forgot to mark, it would be an active false denial
    // rather than mere silence. Omitting produces the same platform-side result either way.
    for (const p of WITH_FIELD) {
      expect(disclosureForPlatform(p, "none")).toMatchObject({ value: null, supported: true });
    }
  });

  it("still records that a platform HAS a field we deliberately left unset", () => {
    // `supported` must not collapse into `value` — the audit trail has to distinguish "the platform has
    // no field" from "the platform has one and we chose not to set it".
    expect(disclosureForPlatform("youtube", "none")).toMatchObject({ supported: true, field: "status.containsSyntheticMedia" });
    expect(disclosureForPlatform("linkedin", "none")).toMatchObject({ supported: false, field: null });
  });

  it("platforms with no API field report unsupported and never invent a value", () => {
    for (const p of WITHOUT_FIELD) {
      const d = disclosureForPlatform(p, "ai_generated");
      expect(d).toMatchObject({ supported: false, field: null, value: null });
      expect(d.reason).toContain("no AI-disclosure field");
    }
  });

  it("an unknown platform degrades safely instead of throwing", () => {
    expect(disclosureForPlatform("mastodon", "ai_generated")).toMatchObject({ supported: false, value: null });
  });

  it("always explains itself — every decision carries a non-empty reason for the audit trail", () => {
    for (const p of [...WITH_FIELD, ...WITHOUT_FIELD]) {
      for (const level of ["none", "ai_assisted", "ai_generated"] as const) {
        expect(disclosureForPlatform(p, level).reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("disclosureFlag — the normalized boolean handed to providers", () => {
  it("is undefined where the platform has no field, so nothing is sent", () => {
    for (const p of WITHOUT_FIELD) expect(disclosureFlag(p, "ai_generated")).toBeUndefined();
  });

  it("mirrors the mapping for platforms that do have one", () => {
    expect(disclosureFlag("youtube", "ai_generated")).toBe(true);
    expect(disclosureFlag("youtube", "ai_assisted")).toBe(false);
    expect(disclosureFlag("instagram", "ai_assisted")).toBe(true);
    expect(disclosureFlag("tiktok", "none")).toBeUndefined(); // nothing declared → nothing sent
  });
});

describe("requiresInContentNote", () => {
  it("is true for any declared AI involvement", () => {
    expect(requiresInContentNote("ai_assisted")).toBe(true);
    expect(requiresInContentNote("ai_generated")).toBe(true);
  });

  it("is false when nothing was declared", () => {
    expect(requiresInContentNote("none")).toBe(false);
  });
});
