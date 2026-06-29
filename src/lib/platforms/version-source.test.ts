/**
 * Single-source-of-truth guard for the Meta Graph API version (VPROBE1).
 *
 * The Graph API version must live in exactly ONE place — `constants.ts` (`META_API_VERSION` →
 * `GRAPH_API_BASE`). A hardcoded `graph.facebook.com/vNN.N` literal anywhere else means a version
 * bump silently misses that file (this is precisely how the publishing layer drifted to v21.0 while
 * messaging was on v25.0). This test fails the moment such a literal reappears.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  META_API_VERSION,
  GRAPH_API_BASE,
  META_OAUTH_BASE,
  IG_GRAPH_API_VERSION,
  IG_GRAPH_BASE,
} from "./constants";

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

/**
 * Same guard for the Instagram Graph API version (IGML1). Instagram Business Login talks to
 * `graph.instagram.com` (a different host than `graph.facebook.com`), versioned independently via
 * `IG_GRAPH_API_VERSION` → `IG_GRAPH_BASE` in `constants.ts`. A hardcoded `graph.instagram.com/vNN.N`
 * literal anywhere under `src/lib/platforms` or `src/server/handlers/oauth` means a version bump
 * silently misses that file. This test fails the moment such a literal reappears.
 *
 * Directories are scanned recursively (rather than an explicit file list) because the IG surface is
 * still growing — new IG modules are guarded automatically.
 */
const IG_SCAN_DIRS = ["src/lib/platforms", "src/server/handlers/oauth"];
const HARDCODED_IG_VERSION = /graph\.instagram\.com\/v\d+\.\d+/g;

function collectTsFiles(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(abs));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(abs);
    }
  }
  return out;
}

const IG_SOURCE_FILES = IG_SCAN_DIRS.flatMap((dir) =>
  collectTsFiles(join(process.cwd(), dir)).map((abs) => abs.replace(`${process.cwd()}/`, "")),
);

describe("Instagram Graph API version — single source of truth", () => {
  it("constants derive the base URL from IG_GRAPH_API_VERSION", () => {
    expect(IG_GRAPH_API_VERSION).toMatch(/^v\d+\.\d+$/);
    expect(IG_GRAPH_BASE).toBe(`https://graph.instagram.com/${IG_GRAPH_API_VERSION}`);
  });

  it("scans at least one source file under the guarded directories", () => {
    expect(IG_SOURCE_FILES.length).toBeGreaterThan(0);
  });

  it.each(IG_SOURCE_FILES)("%s has no hardcoded graph.instagram.com version literal", (rel) => {
    // The guard file itself contains the regex/example literals — skip it.
    if (rel.endsWith("version-source.test.ts")) return;
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const matches = src.match(HARDCODED_IG_VERSION) ?? [];
    expect(matches, `hardcoded version literal(s) in ${rel}: ${matches.join(", ")} — use IG_GRAPH_BASE`).toEqual([]);
  });
});
