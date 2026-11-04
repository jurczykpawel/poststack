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
  // PROVFIX1: YouTube refuses comments on a private video (recorded 403, __fixtures__/recorded/youtube-upload-private.json)
  // and the provider uploads as private unless told otherwise — the comment could only fail and alert.
  it.each([[undefined], ["private"]])("skips a YouTube video published as private (privacyStatus=%s)", async (privacyStatus) => {
    expect(await firstCommentEligibility({ ...channel, platform: "youtube" }, { options: privacyStatus ? { privacyStatus } : {} })).toEqual({
      text: "default", reason: "private_post",
    });
  });
  it.each(["unlisted", "public"])("comments on a YouTube video published as %s (recorded: accepted on unlisted)", async (privacyStatus) => {
    expect(await firstCommentEligibility({ ...channel, platform: "youtube" }, { options: { privacyStatus } })).toEqual({ text: "default" });
  });
  it("treats absent text as empty", async () => {
    expect(await firstCommentEligibility({ ...channel, default_first_comment: null }, {})).toEqual({
      text: "", reason: "no_text",
    });
  });
});
