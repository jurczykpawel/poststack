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

  it("keeps Facebook and Instagram Login probes on separate hosts and credentials", () => {
    expect(probe).toContain('const IG_TOKEN = process.env.META_PROBE_IG_TOKEN;');
    expect(probe).toContain('const IG_BASE = `https://graph.instagram.com/${VERSION}`;');
    expect(probe).toContain('`${IG_BASE}/me?fields=user_id,username,account_type`');
    expect(probe).toContain('`${IG_BASE}/${IG_USER_ID}?fields=name,username,profile_pic,is_user_follow_business`');
    expect(probe).toContain('`${IG_BASE}/me/messages`');
    expect(probe).toContain('accessToken: IG_TOKEN');
    expect(probe).not.toContain('`${BASE}/${IG_USER_ID}?');
  });

  it("passes the Instagram Login token to the strict workflow", () => {
    expect(workflow).toContain("META_PROBE_IG_TOKEN: ${{ secrets.META_PROBE_IG_TOKEN }}");
    expect(workflow).toContain("META_PROBE_IG_USER_ID: ${{ secrets.META_PROBE_IG_USER_ID }}");
  });

  it("does not let an open review issue suppress a confirmed live probe", () => {
    expect(workflow).toContain('ISSUE_COUNT" -gt 0 ] && [ "${{ steps.mode.outputs.strict }}" != "true"');
    expect(workflow.indexOf("id: mode")).toBeLessThan(workflow.indexOf("id: existing"));
  });

  it("reuses the detected-version issue instead of creating strict-run duplicates", () => {
    expect(workflow).toContain('echo "issue_number=$ISSUE_NUMBER" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('gh issue comment "$ISSUE_NUMBER"');
    expect(workflow).toContain('echo "Closes #${ISSUE_NUMBER}"');
  });

  it("replaces a stale bot branch left by a closed bump PR instead of failing the push", () => {
    // An open PR for the version already short-circuits the run (PR_COUNT), so the branch is only
    // ever a leftover from a closed attempt and is safe to overwrite.
    expect(workflow).toContain('PR_COUNT=$(gh pr list --search "Meta API $NEXT" --state open');
    expect(workflow).toContain('git push --force origin "$BRANCH"');
  });

  it("builds PR/issue bodies from files, never from indented heredocs", () => {
    expect(workflow).toContain('--body-file "$BODY_FILE"');
    expect(workflow).not.toMatch(/<<EOF/);
  });

  it("keeps a mandatory manual real-IG-DM check and the changelog digest in the bump PR", () => {
    expect(workflow).toContain("send one real Instagram DM");
    expect(workflow).toContain('bun scripts/meta-changelog-scan.ts "${{ steps.version.outputs.latest }}"');
    expect(workflow).toContain('cat "$RUNNER_TEMP/changelog-digest.md"');
  });

  it("probes the IG send contract with the production payload and reports it as partial coverage", () => {
    expect(probe).toContain("buildInstagramDmBody(IG_PROBE_UNKNOWN_RECIPIENT_ID");
    expect(probe).toContain('outcome: "PARTIAL"');
    expect(probe).toContain("await probeIgSendContract();");
  });

  it("relaxes strict mode only for the legs that need a real IG recipient", () => {
    const optionalCalls = probe.match(/^\s*optional\("([^"]+)"/gm) ?? [];
    expect(optionalCalls.map((c) => c.trim())).toEqual([
      'optional("GET IG recipient profile + follow state"',
      'optional("POST IG /me/messages (send DM)"',
    ]);
  });

  it("keeps provider tokens out of ordinary request URLs and bodies", () => {
    expect(probe).toContain('headers.set("authorization", `Bearer ${opts.accessToken}`)');
    expect(probe).not.toContain("access_token: PAGE_TOKEN");
    expect(probe).not.toContain("access_token: IG_TOKEN");
  });
});
