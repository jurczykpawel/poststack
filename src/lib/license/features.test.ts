import { describe, it, expect } from "vitest";
import { tierFeatures, featureArea, getFeature, FEATURES, type Feature } from "@/lib/license/features";
import { AREAS } from "@/lib/license/areas";

describe("feature registry", () => {
  it("every feature has a valid area, tier, and status", () => {
    for (const f of FEATURES) {
      expect(AREAS).toContain(f.area);
      expect(["free", "registered", "pro", "business"]).toContain(f.minTier);
      expect(["live", "planned"]).toContain(f.status);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it("has unique feature keys", () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tags features with their functional area", () => {
    expect(featureArea("sequences")).toBe("replies");
    expect(featureArea("contacts_crm")).toBe("replies");
    expect(featureArea("managed_connection")).toBe("core");
    expect(featureArea("api_access")).toBe("core");
    expect(featureArea("multi_workspace")).toBe("core");
    expect(featureArea("multi_brand")).toBe("publishing");
    expect(featureArea("webhook_filtering")).toBe("publishing");
  });

  it("getFeature returns undefined for an unknown key", () => {
    expect(getFeature("nope")).toBeUndefined();
  });
});

describe("tierFeatures", () => {
  it("grants personalization on the pro tier", () => {
    expect(tierFeatures("pro").has("personalization")).toBe(true);
  });

  it("grants the full PRO replies feature set on the pro tier", () => {
    const pro = tierFeatures("pro");
    for (const f of ["ai_rephrase", "sequences", "interactive_messages", "follow_gate", "multi_channel", "non_meta_channels", "contacts_crm", "manual_reply", "reaction_trigger", "managed_connection", "api_access"] as const) {
      expect(pro.has(f)).toBe(true);
    }
  });

  it("gates the Meta managed connection + API access to PRO, not free", () => {
    for (const f of ["managed_connection", "api_access"] as const) {
      expect(tierFeatures("pro").has(f)).toBe(true);
      expect(tierFeatures("business").has(f)).toBe(true);
      expect(tierFeatures("free").has(f)).toBe(false);
      expect(tierFeatures(null).has(f)).toBe(false);
    }
  });

  it("gates manual replying (manual_reply) to PRO — free is rules-only auto-reply", () => {
    expect(tierFeatures("pro").has("manual_reply")).toBe(true);
    expect(tierFeatures("free").has("manual_reply")).toBe(false);
    expect(tierFeatures(null).has("manual_reply")).toBe(false);
  });

  it("gates customer inbox/CRM visibility (contacts_crm) to PRO, not free", () => {
    expect(tierFeatures("pro").has("contacts_crm")).toBe(true);
    expect(tierFeatures("free").has("contacts_crm")).toBe(false);
    expect(tierFeatures(null).has("contacts_crm")).toBe(false);
  });

  it("grants nothing on the free tier", () => {
    expect(tierFeatures("free").size).toBe(0);
  });

  it("falls back to free for an unknown / null tier", () => {
    expect(tierFeatures("enterprise-galaxy").size).toBe(0);
    expect(tierFeatures(null).size).toBe(0);
  });

  it("gates multitenancy (multi_workspace) to the business tier only", () => {
    // Multitenancy is owner-only for now: pro (sold today) must NOT unlock it,
    // only business (no Sellf variant yet → effectively off for everyone else).
    expect(tierFeatures("business").has("multi_workspace")).toBe(true);
    expect(tierFeatures("pro").has("multi_workspace")).toBe(false);
    expect(tierFeatures("free").has("multi_workspace")).toBe(false);
    expect(tierFeatures(null).has("multi_workspace")).toBe(false);
  });

  it("makes business a superset of pro", () => {
    const pro = tierFeatures("pro");
    const business = tierFeatures("business");
    for (const f of pro) expect(business.has(f as Feature)).toBe(true);
    expect(business.size).toBeGreaterThan(pro.size);
  });
});
