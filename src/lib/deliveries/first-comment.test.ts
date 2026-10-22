import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstCommentEligibility } from "./first-comment";
import { hasFeature } from "@/lib/license/gate";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/license/gate", () => ({ hasFeature: vi.fn() }));
const channel = { platform: "instagram" as const, default_first_comment: " default " };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(hasFeature).mockResolvedValue(true); });

describe("firstCommentEligibility", () => {
  it("inherits and trims the channel default", async () => {
    expect(await firstCommentEligibility(channel, {})).toEqual({ text: "default" });
  });
  it("honours an empty override before the license check", async () => {
    expect(await firstCommentEligibility(channel, { firstComment: " " })).toEqual({ text: "", reason: "no_text" });
    expect(hasFeature).not.toHaveBeenCalled();
  });
  it("checks licensing before platform support", async () => {
    vi.mocked(hasFeature).mockResolvedValue(false);
    expect(await firstCommentEligibility({ ...channel, platform: "linkedin" }, {})).toEqual({
      text: "default", reason: "unlicensed",
    });
  });
  it.each(["linkedin", "telegram"] as const)("recognises unsupported %s", async (platform) => {
    expect(await firstCommentEligibility({ ...channel, platform }, {})).toEqual({
      text: "default", reason: "unsupported_platform",
    });
  });
  it("treats absent text as empty", async () => {
    expect(await firstCommentEligibility({ ...channel, default_first_comment: null }, {})).toEqual({
      text: "", reason: "no_text",
    });
  });
});
