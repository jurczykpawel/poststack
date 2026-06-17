/**
 * Single-source-of-truth guard for the Meta Graph API version (VPROBE1).
 *
 * The Graph API version must live in exactly ONE place — `constants.ts` (`META_API_VERSION` →
 * `GRAPH_API_BASE`). A hardcoded `graph.facebook.com/vNN.N` literal anywhere else means a version
 * bump silently misses that file (this is precisely how the publishing layer drifted to v21.0 while
 * messaging was on v25.0). This test fails the moment such a literal reappears.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { META_API_VERSION, GRAPH_API_BASE, META_OAUTH_BASE } from "./constants";

// Every module that talks to the Facebook/Instagram Graph API. All MUST derive the version from
// constants (import GRAPH_API_BASE / META_OAUTH_BASE), never inline a `graph.facebook.com/vNN.N`.
const META_SOURCE_FILES = [
  "src/lib/platforms/facebook.ts",
  "src/lib/platforms/instagram.ts",
  "src/lib/platforms/meta-graph.ts",
  "src/lib/platforms/meta-token.ts",
  "src/lib/providers/meta.ts",
];

const HARDCODED_FB_VERSION = /graph\.facebook\.com\/v\d+\.\d+/g;

describe("Meta Graph API version — single source of truth", () => {
  it("constants derive the base URLs from META_API_VERSION", () => {
    expect(META_API_VERSION).toMatch(/^v\d+\.\d+$/);
    expect(GRAPH_API_BASE).toBe(`https://graph.facebook.com/${META_API_VERSION}`);
    expect(META_OAUTH_BASE).toBe(`https://www.facebook.com/${META_API_VERSION}`);
  });

  it.each(META_SOURCE_FILES)("%s has no hardcoded graph.facebook.com version literal", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const matches = src.match(HARDCODED_FB_VERSION) ?? [];
    expect(matches, `hardcoded version literal(s) in ${rel}: ${matches.join(", ")} — use GRAPH_API_BASE`).toEqual([]);
  });
});
