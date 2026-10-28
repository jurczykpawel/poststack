import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, withBrand } from "@/lib/brand";
import { brandedLanding } from "./landing-branding";

const source = readFileSync("landing/src/pages/privacy.astro", "utf8");
const headings = (body: string) => [...body.matchAll(/<h2[^>]*>(\d+)\./g)].map((match) => Number(match[1]));

describe("privacy section numbering", () => {
  it("keeps the default policy consecutive", () => {
    expect(headings(source)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("keeps the instance policy consecutive after replacing website analytics", async () => {
    const body = await withBrand({ ...DEFAULT_BRAND, name: "Orchard" }, () => brandedLanding(`<main>${source}</main>`, "privacy/index.html"));
    expect(headings(body)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(body).toContain("3. The Orchard application");
    expect(body).toContain('id="telemetry"');
    expect(body).not.toContain("Analytics &amp; ad measurement");
  });
});
