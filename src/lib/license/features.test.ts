import { describe, it, expect } from "vitest";
import { tierFeatures, TIER_FEATURES } from "@/lib/license/features";

describe("tierFeatures", () => {
  it("grants personalization on the pro tier", () => {
    expect(tierFeatures("pro").has("personalization")).toBe(true);
  });

  it("grants the full PRO feature set on the pro tier", () => {
    const pro = tierFeatures("pro");
    for (const f of ["ai_rephrase", "sequences", "interactive_messages", "follow_gate", "multi_channel", "non_meta_channels", "contacts_crm"] as const) {
      expect(pro.has(f)).toBe(true);
    }
  });

  it("gates customer inbox/CRM visibility (contacts_crm) to PRO, not free", () => {
    // Free keeps unlimited message *handling*, but seeing individual contacts/conversations
    // is the paid CRM layer. Storage still happens on free; only visibility is gated.
    expect(tierFeatures("pro").has("contacts_crm")).toBe(true);
    expect(tierFeatures("business").has("contacts_crm")).toBe(true);
    expect(tierFeatures("free").has("contacts_crm")).toBe(false);
    expect(tierFeatures(null).has("contacts_crm")).toBe(false);
  });

  it("grants nothing on the free tier", () => {
    expect(tierFeatures("free").size).toBe(0);
  });

  it("falls back to free for an unknown tier", () => {
    expect(tierFeatures("enterprise-galaxy").size).toBe(0);
  });

  it("falls back to free for a null tier (no/invalid license)", () => {
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
    for (const f of pro) expect(business.has(f)).toBe(true);
    expect(business.size).toBeGreaterThan(pro.size);
  });

  it("is extensible: every declared tier maps to a feature array", () => {
    for (const features of Object.values(TIER_FEATURES)) {
      expect(Array.isArray(features)).toBe(true);
    }
  });
});
