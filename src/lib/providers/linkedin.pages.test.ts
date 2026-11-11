import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedinProvider, LINKEDIN_API_VERSION } from "./linkedin";
import { PermissionError, TokenInvalidError } from "./errors";
import pages from "../../../tests/fixtures/provider-docs/linkedin-pages.json";
import article from "../../../tests/fixtures/provider-docs/article-story.json";

vi.mock("@/lib/media/ssrf", () => ({ safeFetch: (url: string, init?: RequestInit) => fetch(url, init) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const tokens = { accessToken: "AT", refreshToken: "RT" };
const ORG = "90000002";
const PAGE = { subKind: "organization" };
type Call = { url: string; method: string; headers: Headers; body: string };

/** One stub for every LinkedIn endpoint the provider touches; records each request. */
function stubLinkedIn(over: (url: string) => Response | undefined = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" });
    const forced = over(url);
    if (forced) return forced;
    if (url.includes("/organizationAcls")) return Response.json(pages.organizationAcls.body, { status: pages.organizationAcls.status });
    const org = /\/rest\/organizations\/(\d+)$/.exec(url)?.[1];
    if (org) { const r = pages.organizations[org as keyof typeof pages.organizations]; return Response.json(r.body, { status: r.status }); }
    if (url.includes("registerUpload")) return Response.json({ value: { asset: "urn:li:digitalmediaAsset:A1", uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://www.linkedin.com/dms-uploads/A1" } } } });
    if (url.includes("/rest/images?action=initializeUpload")) return Response.json(article.imageUpload);
    if (url.includes("/rest/videos?action=initializeUpload")) return Response.json({ value: { video: "urn:li:video:V1", uploadToken: "", uploadInstructions: [{ firstByte: 0, lastByte: 2, uploadUrl: "https://www.linkedin.com/dms-uploads/V1" }] } });
    if (url.includes("finalizeUpload")) return new Response(null);
    if (url.includes("dms-uploads")) return new Response(null, { status: 201, headers: { etag: '"p1"' } });
    if (url.endsWith("/ugcPosts")) return Response.json(pages.ugcPostAsOrganization.body, { status: pages.ugcPostAsOrganization.status, headers: pages.ugcPostAsOrganization.headers });
    if (url.endsWith("/rest/posts")) return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:ugcPost:7390000000000000001" } });
    // media source: HEAD size + ranged bytes
    if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "3" } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
  }));
  return calls;
}

const owners = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.body).map((c) => {
  const b = JSON.parse(c.body);
  return b.author ?? b.registerUploadRequest?.owner ?? b.initializeUploadRequest?.owner;
}).filter(Boolean);

const FORMATS = [
  { format: "text", media: [] as string[] },
  { format: "image", media: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"] },
  { format: "video", media: ["https://cdn.example/v.mp4"] },
  { format: "article", media: ["https://cdn.example/thumb.png"] },
];

describe("LinkedIn Company Pages", () => {
  it("keeps the default connect scopes member-only; page scopes are opt-in", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "id");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "secret");
    const config = await linkedinProvider.oauthConfig!();
    expect(config!.scopes).toEqual(["openid", "profile", "w_member_social"]);
    expect(config!.subAccountScopes).toEqual(["w_organization_social", "r_organization_admin"]);
  });

  it("lists pages from the recorded organizationAcls + organization lookups", async () => {
    const calls = stubLinkedIn();
    const subs = await linkedinProvider.enumerateSubAccounts!(tokens);
    expect(subs.map((s) => [s.providerAccountId, s.displayName, s.metadata])).toEqual([
      ["90000001", "Example Foundation", { subKind: "organization", vanityName: "example-foundation" }],
      ["90000002", "Example Academy", { subKind: "organization", vanityName: "example-academy" }],
    ]);
    expect(subs.every((s) => s.token === tokens && s.platform === "linkedin")).toBe(true);
    expect(calls[0]!.url).toBe("https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100");
    expect(calls.every((c) => c.headers.get("LinkedIn-Version") === LINKEDIN_API_VERSION)).toBe(true);
    expect(calls.every((c) => c.headers.get("authorization") === "Bearer AT")).toBe(true);
  });

  it("keeps only roles that can post, deduplicates pages, and names a page it cannot look up", async () => {
    const acl = { elements: [
      { role: "CONTENT_ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:1" },
      { role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:1" },
      { role: "ANALYST", state: "APPROVED", organization: "urn:li:organization:2" },
      { role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organizationBrand:3" },
    ] };
    const calls = stubLinkedIn((u) => u.includes("organizationAcls") ? Response.json(acl) : u.endsWith("/organizations/1") ? Response.json({}, { status: 403 }) : undefined);
    const subs = await linkedinProvider.enumerateSubAccounts!(tokens);
    expect(subs.map((s) => [s.providerAccountId, s.displayName])).toEqual([["1", "LinkedIn Page 1"]]);
    expect(calls.filter((c) => c.url.includes("/organizations/"))).toHaveLength(1);
  });

  it("explains a missing page permission and flags a dead token for reauth", async () => {
    stubLinkedIn((u) => u.includes("organizationAcls") ? Response.json(pages.aclDenied.body, { status: pages.aclDenied.status }) : undefined);
    await expect(linkedinProvider.enumerateSubAccounts!(tokens)).rejects.toThrow(PermissionError);
    await expect(linkedinProvider.enumerateSubAccounts!(tokens)).rejects.toThrow(/Community Management API/);
    stubLinkedIn((u) => u.includes("organizationAcls") ? Response.json({ message: "expired" }, { status: 401 }) : undefined);
    await expect(linkedinProvider.enumerateSubAccounts!(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
    stubLinkedIn((u) => u.includes("/organizations/") ? Response.json({}, { status: 401 }) : undefined);
    await expect(linkedinProvider.enumerateSubAccounts!(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it.each(FORMATS)("publishes $format as the page: every upload owner and the post author is the organization", async ({ format, media }) => {
    const calls = stubLinkedIn();
    const h = await linkedinProvider.publish({ tokens, accountId: ORG, channelMetadata: PAGE, mediaUrls: media,
      mediaKinds: media.map(() => (format === "video" ? "video" : "image")),
      request: { format, caption: "hello", title: article.article.title, media: media.map(() => ({ mediaId: "m" })), options: { articleUrl: article.article.source } } });
    expect(h.providerHandle).toMatch(/^urn:li:(share|ugcPost):\d{19}$/);
    expect(owners(calls).length).toBeGreaterThan(0);
    expect(new Set(owners(calls))).toEqual(new Set([`urn:li:organization:${ORG}`]));
  });

  it.each(FORMATS)("regression: a profile channel still publishes $format as the member", async ({ format, media }) => {
    const calls = stubLinkedIn();
    await linkedinProvider.publish({ tokens, accountId: "li_member", mediaUrls: media, channelMetadata: { video_carousel: "unknown" },
      mediaKinds: media.map(() => (format === "video" ? "video" : "image")),
      request: { format, caption: "hello", title: article.article.title, media: media.map(() => ({ mediaId: "m" })), options: { articleUrl: article.article.source } } });
    expect(new Set(owners(calls))).toEqual(new Set(["urn:li:person:li_member"]));
  });

  it("a refused page post names the required role; a refused profile post keeps the generic text", async () => {
    stubLinkedIn((u) => u.endsWith("/ugcPosts") ? Response.json({ message: "Not enough permissions" }, { status: 403 }) : undefined);
    const req = { format: "text", caption: "x", media: [] };
    const page = linkedinProvider.publish({ tokens, accountId: ORG, channelMetadata: PAGE, request: req, mediaUrls: [] });
    await expect(page).rejects.toBeInstanceOf(PermissionError);
    await expect(linkedinProvider.publish({ tokens, accountId: ORG, channelMetadata: PAGE, request: req, mediaUrls: [] })).rejects.toThrow(/Super admin or Content admin/);
    await expect(linkedinProvider.publish({ tokens, accountId: "li_member", request: req, mediaUrls: [] })).rejects.toThrow(/^provider permission\/access required/);
  });

  it("a dead token on a page post stays a reauth error", async () => {
    stubLinkedIn((u) => u.endsWith("/ugcPosts") ? Response.json({ message: "expired" }, { status: 401 }) : undefined);
    await expect(linkedinProvider.publish({ tokens, accountId: ORG, channelMetadata: PAGE, request: { format: "text", caption: "x", media: [] }, mediaUrls: [] })).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
