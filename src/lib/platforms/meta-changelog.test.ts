import { describe, it, expect } from "vitest";
import { changelogUrl, parseChangelogSections, relevantChangelogSections, changelogDigest } from "./meta-changelog";

// Trimmed from the real v26.0 changelog markup (h1 version → h2 product → h3 topic → h4 change).
const HTML = `
<h1>Version 26.0</h1>
<h2>Graph API</h2>
<h3>Graph API protocol</h3>
<h4>Legacy Graph API protocol features deprecated</h4>
<p>Requests that include <code>date_format</code> return an error. The <code>debug_token</code> endpoint is unaffected.</p>
<h3>Page</h3>
<h4>Deprecation of legacy Page fields</h4>
<p>GET /{page-id}?fields=parking returns a version error.</p>
<h3>Rights Manager</h3>
<h4>Rights Manager owner fields migrated</h4>
<p>Copyright owner fields moved.</p>
<h2>Marketing API</h2>
<h3>Instagram Explore Feed placement</h3>
<h4>Explore ad placement no longer available</h4>
<p>Instagram Explore ads are gone.</p>
<h2>API Version Deprecations</h2>
<p>Version 25.0 will be deprecated on September 1, 2028.</p>
`;

describe("changelogUrl", () => {
  it("points at the Graph API changelog page for the version", () => {
    expect(changelogUrl("v26.0")).toBe("https://developers.facebook.com/docs/graph-api/changelog/version26.0/");
  });
});

describe("parseChangelogSections", () => {
  it("splits the page into leaf sections with their product group and topic", () => {
    const sections = parseChangelogSections(HTML);
    expect(sections.map((s) => [s.group, s.topic, s.title])).toEqual([
      ["Graph API", "Graph API protocol", "Legacy Graph API protocol features deprecated"],
      ["Graph API", "Page", "Deprecation of legacy Page fields"],
      ["Graph API", "Rights Manager", "Rights Manager owner fields migrated"],
      ["Marketing API", "Instagram Explore Feed placement", "Explore ad placement no longer available"],
      ["API Version Deprecations", "", "API Version Deprecations"],
    ]);
    expect(sections[0].text).toContain("date_format");
    expect(sections[0].text).not.toContain("<code>");
  });

  it("ignores inline scripts and styles that follow the last section", () => {
    const withScript = `${HTML}<!-- <div>hidden</div> --><script>requireLazy(["HasteSupportData"],function(m){})</script><style>.x{}</style>`;
    const last = parseChangelogSections(withScript).at(-1)!;
    expect(last.text).toBe("Version 25.0 will be deprecated on September 1, 2028.");
  });
});

describe("relevantChangelogSections", () => {
  it("keeps sections touching surfaces we call, drops unrelated products, keeps version deprecations", () => {
    const titles = relevantChangelogSections(parseChangelogSections(HTML)).map((s) => s.title);
    expect(titles).toEqual([
      "Legacy Graph API protocol features deprecated",
      "Deprecation of legacy Page fields",
      "API Version Deprecations",
    ]);
  });
});

describe("changelogDigest", () => {
  it("renders a markdown review list linking the source", () => {
    const md = changelogDigest("v26.0", relevantChangelogSections(parseChangelogSections(HTML)));
    expect(md).toContain("https://developers.facebook.com/docs/graph-api/changelog/version26.0/");
    expect(md).toContain("**Graph API › Page — Deprecation of legacy Page fields**");
    expect(md).toContain("parking");
  });

  it("says so explicitly when nothing relevant was found", () => {
    expect(changelogDigest("v26.0", [])).toMatch(/no sections mention/i);
  });
});
