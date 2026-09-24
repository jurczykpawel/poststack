import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/ci/image-tags.sh");
const release = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");

/** Run the script and parse its GITHUB_OUTPUT multiline blocks (`name<<DELIM … DELIM`). */
function imageTags(ref: string): Record<string, string[]> {
  const out = execFileSync("bash", [script, ref, "ghcr.io/o/app", "ghcr.io/o/app-worker"], { encoding: "utf8" });
  const blocks: Record<string, string[]> = {};
  for (const m of out.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) blocks[m[1]] = m[3].split("\n");
  return blocks;
}

describe("release image tags", () => {
  it("publishes a stable release under its version and :latest", () => {
    expect(imageTags("v0.14.0")).toEqual({
      web: ["ghcr.io/o/app:v0.14.0", "ghcr.io/o/app:latest"],
      worker: ["ghcr.io/o/app-worker:v0.14.0", "ghcr.io/o/app-worker:latest"],
    });
  });

  it("keeps a pre-release (TEST-only) tag off :latest so self-hosters never pull it", () => {
    expect(imageTags("v0.14.0-rc.1")).toEqual({
      web: ["ghcr.io/o/app:v0.14.0-rc.1"],
      worker: ["ghcr.io/o/app-worker:v0.14.0-rc.1"],
    });
  });

  it("rejects a ref that is not a version tag", () => {
    expect(() => imageTags("main")).toThrow();
  });

  it("is what the release workflow uses for both images", () => {
    expect(release).toContain('scripts/ci/image-tags.sh "$GITHUB_REF_NAME" "$IMAGE" "$WORKER_IMAGE" >> "$GITHUB_OUTPUT"');
    expect(release).toContain("tags: ${{ steps.image-tags.outputs.web }}");
    expect(release).toContain("tags: ${{ steps.image-tags.outputs.worker }}");
    expect(release).not.toMatch(/:latest\s*$/m);
  });
});
