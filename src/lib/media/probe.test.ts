import { describe, it, expect } from "vitest";
import { defaultProbe } from "./probe";
import { sniffMime } from "./sniff";
import { ApiError } from "@/lib/api/response";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
// "....ftypmp42" — a minimal MP4 box header.
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

describe("sniffMime [PSA12]", () => {
  it("classifies by magic bytes", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(MP4)).toBe("video/mp4");
  });
  it("returns undefined for unrecognized content", () => {
    expect(sniffMime(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe("defaultProbe [PSA12]", () => {
  it("derives kind + mime from the bytes, not the declared header", async () => {
    expect(await defaultProbe(PNG, "image/png")).toMatchObject({ kind: "image", mime: "image/png" });
    expect(await defaultProbe(MP4, "video/mp4")).toMatchObject({ kind: "video", mime: "video/mp4" });
  });

  it("ignores a (lying) declared mime and trusts the sniff when the top-level type agrees", async () => {
    // declared image/jpeg but bytes are PNG → both images → accepted, mime corrected to the truth
    expect(await defaultProbe(PNG, "image/jpeg")).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("rejects content whose declared type contradicts the bytes (content-confusion)", async () => {
    // an MP4 served as image/png → top-level mismatch → rejected
    await expect(defaultProbe(MP4, "image/png")).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects an unrecognized blob even when a media Content-Type is declared", async () => {
    await expect(defaultProbe(new Uint8Array([1, 2, 3, 4]), "image/png")).rejects.toBeInstanceOf(ApiError);
  });
});
