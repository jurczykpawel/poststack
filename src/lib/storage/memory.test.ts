import { describe, it, expect } from "vitest";
import { InMemoryStorage } from "./memory";

describe("InMemoryStorage", () => {
  it("put then head reports existence and size", async () => {
    const s = new InMemoryStorage("https://cdn.test");
    expect((await s.head("k")).exists).toBe(false);
    await s.putBytes("k", new Uint8Array([1, 2, 3]), "video/mp4");
    const h = await s.head("k");
    expect(h.exists).toBe(true);
    expect(h.size).toBe(3);
  });

  it("keeps the development storage size bounded before copying an oversized part", async () => {
    const s = new InMemoryStorage("https://cdn.test");
    async function* oversized() { yield new Uint8Array(256 * 1024 * 1024 + 1); }
    await expect(s.putStream("large", oversized())).rejects.toThrow(/S3/);
    expect((await s.head("large")).exists).toBe(false);
  });

  it("publicUrl joins the base and key", () => {
    const s = new InMemoryStorage("https://cdn.test");
    expect(s.publicUrl("media/sha256/abc.mp4")).toBe("https://cdn.test/media/sha256/abc.mp4");
  });

  it("delete removes the object", async () => {
    const s = new InMemoryStorage("https://cdn.test");
    await s.putBytes("k", new Uint8Array([1]), "image/png");
    await s.delete("k");
    expect((await s.head("k")).exists).toBe(false);
  });
});
