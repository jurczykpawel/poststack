import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

// PSA20: the admin shell loads vendored, buildless htmx + Alpine. Provenance is verified-vs-jsDelivr
// today, but nothing stops a future commit from silently swapping the bytes. This tripwire pins the
// sha256 of each vendored file in INTEGRITY.txt and runs in the gate (locally + CI via `bun run test`),
// so a tampered or un-pinned bundle fails the build.
const VENDOR = `${process.cwd()}/src/server/ui/static/vendor`;

const manifest = readFileSync(`${VENDOR}/INTEGRITY.txt`, "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const [hash, file] = line.trim().split(/\s+/);
    return { hash: hash!, file: file! };
  });

describe("vendored asset integrity [PSA20]", () => {
  it("every vendored .js file is pinned in INTEGRITY.txt", () => {
    const jsFiles = readdirSync(VENDOR).filter((f) => f.endsWith(".js")).sort();
    expect(manifest.map((m) => m.file).sort()).toEqual(jsFiles);
  });

  it("each vendored file matches its pinned sha256", () => {
    for (const { hash, file } of manifest) {
      const actual = createHash("sha256").update(readFileSync(`${VENDOR}/${file}`)).digest("hex");
      expect(actual, `${file} changed — only update INTEGRITY.txt for an intentional, verified bump`).toBe(hash);
    }
  });
});
