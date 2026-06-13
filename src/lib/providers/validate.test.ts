import { describe, it, expect } from "vitest";
import { validate } from "./validate";
import type { Provider, FormatCapability } from "./types";

// A minimal fake provider exercising validate()'s capability checks. (When the meta adapter lands in
// Task 4 it gets its own publish tests; validate() itself is generic and tested here against a
// hand-built capability set mirroring Meta's reel/carousel limits.)
const caps: FormatCapability[] = [
  { format: "reel", media: { min: 1, max: 1, kinds: ["video"] }, caption: { maxLength: 2200, required: false }, mediaIngestion: "resumable_upload" },
  { format: "carousel", media: { min: 2, max: 10, kinds: ["image", "video"] }, caption: { maxLength: 2200, required: false }, mediaIngestion: "resumable_upload" },
];
const fakeProvider = { id: "meta", capabilities: () => caps } as unknown as Provider;

const media = (n: number) => Array.from({ length: n }, (_, i) => ({ mediaId: `m${i}` }));

describe("validate(provider, request)", () => {
  it("accepts a valid reel", () => {
    expect(validate(fakeProvider, { format: "reel", media: media(1), caption: "hi" }).ok).toBe(true);
  });
  it("rejects an unknown format", () => {
    expect(validate(fakeProvider, { format: "nope", media: media(1) }).ok).toBe(false);
  });
  it("rejects too many carousel items (>10)", () => {
    expect(validate(fakeProvider, { format: "carousel", media: media(11) }).ok).toBe(false);
  });
  it("rejects too few media for reel (0)", () => {
    expect(validate(fakeProvider, { format: "reel", media: media(0) }).ok).toBe(false);
  });
  it("rejects an over-long caption", () => {
    expect(
      validate(fakeProvider, { format: "reel", media: media(1), caption: "x".repeat(3000) }).ok,
    ).toBe(false);
  });
});
