import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { SharpStoryRenderer, STORY_WIDTH, STORY_HEIGHT } from "./renderer";

describe("SharpStoryRenderer", () => {
  const renderer = new SharpStoryRenderer();

  it("renders a 1080x1920 JPEG card from caption only (no thumbnail)", async () => {
    const bytes = await renderer.render({ caption: "Nowy post! Sprawdź link w bio 🔥", accountName: "TechSkills" });
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("composites a thumbnail when one is provided", async () => {
    const thumb = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const bytes = await renderer.render({ caption: "Z miniaturą", thumbnail: new Uint8Array(thumb) });
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
  });

  it("handles an empty caption and a very long caption without throwing", async () => {
    await expect(renderer.render({ caption: "" })).resolves.toBeInstanceOf(Uint8Array);
    const long = "słowo ".repeat(400);
    const bytes = await renderer.render({ caption: long });
    expect((await sharp(Buffer.from(bytes)).metadata()).height).toBe(STORY_HEIGHT);
  });

  it("escapes XML-special characters so the SVG overlay never breaks", async () => {
    const bytes = await renderer.render({ caption: `<script>alert(1)</script> & "quote" 'apos'`, accountName: `A & B <x>` });
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
  });

  it("ignores an unreadable thumbnail and still renders the card", async () => {
    const bytes = await renderer.render({ caption: "Broken thumb", thumbnail: new Uint8Array([1, 2, 3, 4, 5]) });
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect(meta.width).toBe(STORY_WIDTH);
    expect(meta.height).toBe(STORY_HEIGHT);
  });
});
