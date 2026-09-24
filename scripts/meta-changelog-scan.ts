/**
 * Print the Meta Graph API changelog sections for a version that touch surfaces PostStack calls
 * (VPROBE2). A review aid for the version-bump PR, never a gate: it always exits 0, and a fetch
 * failure is reported in the output instead of failing the workflow.
 *
 *   bun scripts/meta-changelog-scan.ts v26.0
 */
import { changelogDigest, changelogUrl, parseChangelogSections, relevantChangelogSections } from "@/lib/platforms/meta-changelog";

async function main() {
  const version = process.argv[2];
  if (!version || !/^v\d+\.\d+$/.test(version)) {
    console.log("Changelog scan skipped: pass a version like v26.0.");
    return;
  }
  const url = changelogUrl(version);
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "user-agent": "Mozilla/5.0 (PostStack changelog scan)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sections = parseChangelogSections(await res.text());
    if (sections.length === 0) throw new Error("page had no recognizable sections (markup changed?)");
    console.log(changelogDigest(version, relevantChangelogSections(sections)));
  } catch (e) {
    console.log(`Changelog scan for ${version} could not run (${e instanceof Error ? e.message : String(e)}) — review ${url} manually.`);
  }
}

main();
