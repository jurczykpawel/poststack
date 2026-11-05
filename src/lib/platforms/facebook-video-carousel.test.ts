import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "@/lib/providers/__fixtures__/facebook-video-carousel.json";
import { facebookVideoCarouselState } from "./facebook-video-carousel";
import { inspectMetaToken } from "./meta-token";
import { FacebookProvider } from "./facebook";

vi.mock("@/lib/settings/config", () => ({ getConfig: async (key: string) => key === "META_APP_ID" ? "111" : "APP_SECRET" }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const pageId = "125730403827906";

async function inspect(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data })));
  return inspectMetaToken("PAGE_TOKEN");
}

describe("Facebook video carousel permissions", () => {
  it("keeps the recorded token without ads unavailable", async () => {
    const info = await inspect(fixture.debugWithoutAds);
    expect(facebookVideoCarouselState(info, pageId, fixture.pageTasks)).toBe("unavailable");
  });
  it.each([undefined, ["CREATE_CONTENT"], ["ADVERTISE"]])("requires both a granular grant and Page tasks %j", async tasks => {
    const info = await inspect(fixture.debugWithAds);
    expect(facebookVideoCarouselState(info, pageId, tasks)).toBe(tasks?.includes("ADVERTISE") ? "available" : tasks ? "unavailable" : "unknown");
  });
  it.each([undefined, [], ["other-page"]])("handles granular target ids %j", async target_ids => {
    const info = await inspect({ ...fixture.debugWithAds, granular_scopes: [{ scope: "pages_manage_ads", ...(target_ids ? { target_ids } : {}) }] });
    expect(facebookVideoCarouselState(info, pageId, ["ADVERTISE"])).toBe(target_ids ? "unavailable" : "available");
  });
  it("does not enable access when debug details or tasks cannot be confirmed", async () => {
    expect(facebookVideoCarouselState(null, pageId, ["ADVERTISE"])).toBe("unknown");
    const unconfirmed = await inspect({ ...fixture.debugWithAds, is_valid: undefined });
    expect(facebookVideoCarouselState(unconfirmed, pageId, ["ADVERTISE"])).toBe("unknown");
    const info = await inspect({ ...fixture.debugWithAds, granular_scopes: undefined });
    expect(facebookVideoCarouselState(info, pageId, ["ADVERTISE"])).toBe("unknown");
    expect(facebookVideoCarouselState(info, "other-page", ["ADVERTISE"])).toBe("unknown");
  });
  it.each([undefined, "false", "true"])("requests ads OAuth only with opt-in %s", async value => {
    vi.stubEnv("META_REQUEST_ADS_SCOPE", value);
    const url = new URL(await new FacebookProvider().generateAuthUrl("state", "https://app.example/callback"));
    expect(url.searchParams.get("scope")!.split(",").includes("pages_manage_ads")).toBe(value === "true");
  });
  it("checks the minted Page token and requests Page tasks during connect", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); calls.push(url.toString());
      if (url.pathname.endsWith("/debug_token")) return Response.json({ data: url.searchParams.get("input_token") === "PAGE_TOKEN" ? fixture.debugWithAds : { ...fixture.debugWithAds, type: "SYSTEM_USER", profile_id: undefined } });
      expect(url.searchParams.get("fields")).toContain("tasks");
      return Response.json({ data: [{ id: pageId, name: "Test Page", access_token: "PAGE_TOKEN", tasks: ["ADVERTISE"] }] });
    }));
    const accounts = await new FacebookProvider().connectWithToken("MASTER_TOKEN");
    expect(accounts[0].videoCarousel).toBe("available");
    expect(calls.some(url => url.includes("input_token=PAGE_TOKEN"))).toBe(true);
  });
});
