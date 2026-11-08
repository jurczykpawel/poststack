import { describe, expect, it, vi } from "vitest";
import { generateOAuthState, verifyOAuthState } from "@/lib/oauth/state";
import { FacebookProvider, FACEBOOK_OAUTH_SCOPES } from "@/lib/platforms/facebook";
import { InstagramProvider, INSTAGRAM_OAUTH_SCOPES } from "@/lib/platforms/instagram";
import { buildInstagramLoginAuthUrl, IG_LOGIN_SCOPES } from "@/lib/platforms/instagram-login";
import type { SessionAuthContext } from "@/lib/auth";
vi.mock("@/lib/settings/config", () => ({ getConfig: async () => "test-app" }));
process.env.JWT_SECRET = "test-consent-secret-at-least-32-characters";
const auth: SessionAuthContext = { workspaceId:"workspace",userId:"user",sessionId:"session",authMethod:"session",scopes:[] };
const purpose = { kind:"insights" as const,channelId:"48c72472-c266-4e02-a626-2b7db7fa877f",transport:"facebook" };
describe("optional Insights consent", () => {
  it("requests the extra permission only for the selected login purpose", async () => {
    expect(INSTAGRAM_OAUTH_SCOPES).toEqual(["pages_show_list","business_management","pages_read_engagement","instagram_basic","instagram_manage_messages","instagram_manage_comments","instagram_content_publish"]);
    expect(INSTAGRAM_OAUTH_SCOPES).not.toContain("instagram_manage_insights");
    expect(IG_LOGIN_SCOPES).not.toContain("instagram_business_manage_insights");
    expect(FACEBOOK_OAUTH_SCOPES).toEqual(["pages_show_list","business_management","pages_messaging","pages_read_engagement","pages_manage_metadata","pages_manage_posts","pages_manage_engagement"]);
    expect(new URL(await new FacebookProvider().generateAuthUrl("state","https://example.com/callback")).searchParams.get("scope")?.split(",")).toEqual([...FACEBOOK_OAUTH_SCOPES]);
    const provider = new InstagramProvider();
    const fb = new URL(await provider.generateAuthUrl("state","https://example.com/callback",purpose));
    expect(fb.searchParams.get("scope")?.split(",")).toEqual([...INSTAGRAM_OAUTH_SCOPES,"instagram_manage_insights"]);
    expect(new URL(await provider.generateAuthUrl("state","https://example.com/callback")).searchParams.get("scope")?.split(",")).toEqual([...INSTAGRAM_OAUTH_SCOPES]);
    const ig = new URL(await buildInstagramLoginAuthUrl("state","https://example.com/callback",{...purpose,transport:"instagram_business"}));
    expect(ig.searchParams.get("scope")?.split(",")).toEqual([...IG_LOGIN_SCOPES,"instagram_business_manage_insights"]);
    expect(new URL(await buildInstagramLoginAuthUrl("state","https://example.com/callback")).searchParams.get("scope")?.split(",")).toEqual([...IG_LOGIN_SCOPES]);
  });
  it("returns the signed purpose for the initiating session and flow", () => {
    const {state,setCookie} = generateOAuthState(auth,"instagram",purpose);
    expect(verifyOAuthState(state,setCookie.split(";")[0],auth,"instagram")).toEqual(purpose);
    expect(() => verifyOAuthState(state,setCookie.split(";")[0],{...auth,sessionId:"other"},"instagram")).toThrow();
    expect(() => verifyOAuthState(state,setCookie.split(";")[0].replace("facebook","instagram_business"),auth,"instagram-login")).toThrow();
  });
  it("requires the original signed purpose fields", () => {
    const {state,setCookie}=generateOAuthState(auth,"instagram",purpose);
    const [cookieState,context,signature]=setCookie.split(";")[0].split(".");
    for (const patch of [{channelId:"00000000-0000-0000-0000-000000000000"},{transport:"instagram_business"},{kind:"connect"},{returnTo:"https://example.net"}]) {
      const parsed=JSON.parse(Buffer.from(context,"base64url").toString());
      parsed.purpose={...parsed.purpose,...patch};
      const updated=Buffer.from(JSON.stringify(parsed)).toString("base64url");
      expect(()=>verifyOAuthState(state,`${cookieState}.${updated}.${signature}`,auth,"instagram")).toThrow();
    }
  });
  it("expires the signed context on the server after ten minutes", () => {
    vi.useFakeTimers();
    try {
      const {state,setCookie} = generateOAuthState(auth,"instagram",purpose);
      vi.advanceTimersByTime(600001);
      expect(() => verifyOAuthState(state,setCookie.split(";")[0],auth,"instagram")).toThrow();
    } finally { vi.useRealTimers(); }
  });
});
