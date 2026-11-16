import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, withBrand } from "@/lib/brand";
import { brandedDiscovery } from "./landing-branding";
import { PUBLIC_PAGES } from "./public-site/pages";

describe("instance discovery", () => {
  it("lists every public page with the current origin", async () => {
    const body = await withBrand({ ...DEFAULT_BRAND, publicUrl: "https://orchard.example" }, () => brandedDiscovery("sitemap-0.xml"));
    for (const { path } of PUBLIC_PAGES) expect(body).toContain(`<loc>https://orchard.example${path}</loc>`);
    expect(body).not.toContain(DEFAULT_BRAND.publicUrl);
  });
});
