import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { SharpStoryRenderer, STORY_WIDTH, STORY_HEIGHT, STORY_TEMPLATES, DEFAULT_STORY_TEMPLATE, resolveStoryTemplate, registerStoryTemplate } from "./renderer";

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

  it("renders the phone template when requested", async () => {
    const bytes = await renderer.render({ caption: "Phone look" }, { template: "phone", accent: "#7aa2f7", brandName: "TSA" });
    expect((await sharp(Buffer.from(bytes)).metadata()).height).toBe(STORY_HEIGHT);
  });
});

// STORYCFG1 — pure layout tests on the template registry (no sharp): the seam that PRO custom
// templates/styling will plug into.
describe("story template registry (STORYCFG1)", () => {
  const style = { accent: "#123abc", brandName: "Acme Brand", ctaLabel: "Zobacz rolkę" };

  it("resolves the default template and falls back for an unknown id", () => {
    expect(resolveStoryTemplate().id).toBe(DEFAULT_STORY_TEMPLATE);
    expect(resolveStoryTemplate("does-not-exist").id).toBe(DEFAULT_STORY_TEMPLATE);
    expect(resolveStoryTemplate("phone").id).toBe("phone");
  });

  it("framed plan carries accent, brand name, CTA label, the caption and a cover rect", () => {
    const p = STORY_TEMPLATES.framed!.plan({ caption: "Twój profil dostaje DM-y gdy śpisz" }, style, true);
    expect(p.bgSvg).toContain("#123abc"); // accent bar
    expect(p.bgSvg).toContain("Twój profil"); // teaser text
    expect(p.overlaySvg).toContain("Acme Brand"); // brand mark
    expect(p.overlaySvg).toContain("Zobacz rolkę"); // CTA pill
    expect(p.cover).toBeTruthy(); // reel cover gets framed
  });

  it("phone plan draws a device frame + CTA and a cover rect", () => {
    const p = STORY_TEMPLATES.phone!.plan({ caption: "x" }, style, true);
    expect(p.cover).toBeTruthy();
    expect(p.overlaySvg).toContain("Zobacz rolkę");
  });

  it("ships all three designed templates (framed, phone, fullbleed) plus classic", () => {
    expect(Object.keys(STORY_TEMPLATES)).toEqual(expect.arrayContaining(["classic", "framed", "phone", "fullbleed"]));
  });

  it("fullbleed covers the whole canvas with the reel cover when a thumbnail is present", () => {
    const p = STORY_TEMPLATES.fullbleed!.plan({ caption: "Tracisz leady" }, style, true);
    expect(p.cover).toEqual({ x: 0, y: 0, w: 1080, h: 1920, radius: 0 });
    expect(p.overlaySvg).toContain("Zobacz rolkę");
    expect(p.overlaySvg).toContain("Acme Brand");
  });

  it("strips emoji from rendered caption (libvips has no colour-emoji font)", () => {
    const p = STORY_TEMPLATES.framed!.plan({ caption: "Tracisz leady 🔥👇 czas" }, style, false);
    expect(p.bgSvg).not.toContain("🔥");
    expect(p.bgSvg).not.toContain("👇");
    expect(p.bgSvg).toContain("Tracisz");
  });

  it("registerStoryTemplate adds a custom template (the PRO extensibility seam)", () => {
    registerStoryTemplate({ id: "custom-test", plan: () => ({ bg: { r: 0, g: 0, b: 0 }, bgSvg: "<svg/>", overlaySvg: "<svg/>" }) });
    expect(resolveStoryTemplate("custom-test").id).toBe("custom-test");
  });
});
