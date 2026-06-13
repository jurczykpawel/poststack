import { describe, it, expect } from "vitest";
import { platformLabel, platformCell } from "./platform";

describe("platformLabel", () => {
  it("splits meta into Instagram / Facebook by subKind", () => {
    expect(platformLabel("meta", { subKind: "instagram" })).toBe("Instagram");
    expect(platformLabel("meta", { subKind: "facebook_page" })).toBe("Facebook");
  });

  it("labels a bare meta master (no subKind) as Meta", () => {
    expect(platformLabel("meta", {})).toBe("Meta");
    expect(platformLabel("meta", null)).toBe("Meta");
    expect(platformLabel("meta")).toBe("Meta");
  });

  it("labels the other known platforms", () => {
    expect(platformLabel("youtube")).toBe("YouTube");
    expect(platformLabel("tiktok")).toBe("TikTok");
    expect(platformLabel("x")).toBe("X");
    expect(platformLabel("linkedin")).toBe("LinkedIn");
    expect(platformLabel("threads")).toBe("Threads");
  });

  it("falls back to the raw platform for unknown values", () => {
    expect(platformLabel("mastodon")).toBe("mastodon");
  });
});

describe("platformCell", () => {
  it("renders an inline brand icon + friendly label for an Instagram channel", () => {
    const out = String(platformCell("meta", { subKind: "instagram" }));
    expect(out).toContain("Instagram");
    expect(out).toContain("<svg");
    expect(out).toContain("#E4405F"); // Instagram brand colour
  });

  it("renders the Facebook icon (brand blue) for a Facebook page", () => {
    const out = String(platformCell("meta", { subKind: "facebook_page" }));
    expect(out).toContain("Facebook");
    expect(out).toContain("<svg");
    expect(out).toContain("#0866FF");
  });

  it("renders just the raw label (no icon) for an unknown platform", () => {
    const out = String(platformCell("mastodon", {}));
    expect(out).toContain("mastodon");
    expect(out).not.toContain("<svg");
  });
});
