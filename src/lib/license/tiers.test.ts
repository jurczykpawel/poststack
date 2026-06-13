import { describe, it, expect } from "vitest";
import { tierRank, normalizeTier, meetsTier } from "./tiers";

describe("tiers", () => {
  it("ranks free < registered < pro < business", () => {
    expect(tierRank("free")).toBe(0);
    expect(tierRank("registered")).toBe(1);
    expect(tierRank("pro")).toBe(2);
    expect(tierRank("business")).toBe(3);
    // the reserved 'registered' tier sits between anonymous free and paid pro
    expect(tierRank("registered")).toBeLessThan(tierRank("pro"));
    expect(tierRank("registered")).toBeGreaterThan(tierRank("free"));
  });

  it("unknown / empty / null → free rank, case-insensitive", () => {
    expect(tierRank(null)).toBe(0);
    expect(tierRank("")).toBe(0);
    expect(tierRank("enterprise")).toBe(0);
    expect(tierRank("PRO")).toBe(2);
    expect(tierRank("  Business ")).toBe(3);
  });

  it("normalizeTier narrows unknown → free", () => {
    expect(normalizeTier("pro")).toBe("pro");
    expect(normalizeTier("nope")).toBe("free");
    expect(normalizeTier(null)).toBe("free");
  });

  it("meetsTier compares ranks", () => {
    expect(meetsTier("pro", "pro")).toBe(true);
    expect(meetsTier("business", "pro")).toBe(true);
    expect(meetsTier("free", "pro")).toBe(false);
    expect(meetsTier(null, "pro")).toBe(false);
    expect(meetsTier("free", "free")).toBe(true);
  });
});
