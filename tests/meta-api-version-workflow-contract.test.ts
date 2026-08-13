import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const workflow = readFileSync(join(root, ".github/workflows/meta-api-version-check.yml"), "utf8");
const probe = readFileSync(join(root, "scripts/meta-version-probe.ts"), "utf8");

describe("Meta API version-update gate", () => {
  it("creates a version-bump PR only after an explicitly confirmed strict live probe", () => {
    expect(workflow).toContain('[ "${{ github.event_name }}" = "workflow_dispatch" ]');
    expect(workflow).toContain('META_PROBE_STRICT: "1"');
    expect(workflow).toContain('META_PROBE_WRITE: "1"');
    expect(workflow).toContain("bun scripts/meta-version-probe.ts");
    expect(workflow).not.toContain("scripts/meta-api-probe.sh");
    expect(workflow).not.toContain('"$PROBE" = "skipped"');
    expect(workflow).toContain('--label "dependencies"');
    expect(workflow).not.toContain('"dependencies,meta-api"');
  });

  it("makes skipped probe coverage fail closed in strict mode", () => {
    expect(probe).toContain('const STRICT = process.env.META_PROBE_STRICT === "1"');
    expect(probe).toContain('outcome: STRICT ? "FAIL" : "SKIP"');
    expect(probe).toContain("process.exit(STRICT ? 1 : 0)");
  });
});
