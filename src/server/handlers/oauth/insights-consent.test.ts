import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateOAuthState } from "@/lib/oauth/state";
import type { SessionAuthContext } from "@/lib/auth";
const mocks=vi.hoisted(()=>({authenticateSession:vi.fn(),consume:vi.fn(),finish:vi.fn(),decline:vi.fn(),authenticate:vi.fn(),exchange:vi.fn(),upsert:vi.fn(),begin:vi.fn()}));
vi.mock("@/lib/auth",()=>({authenticateSession:mocks.authenticateSession}));
vi.mock("@/lib/license/gate",()=>({ProRequiredError:class extends Error {}}));
vi.mock("@/lib/env",()=>({env:{APP_URL:"https://example.com"}}));
vi.mock("@/lib/insights/consent",()=>({beginInsightConsent:mocks.begin,consumeInsightConsent:mocks.consume,finishInsightConsent:mocks.finish,declineInsightConsent:mocks.decline,insightConsentPath:(id:string)=>`/insights?channel=${id}`}));
vi.mock("@/lib/platforms/registry",()=>({getProvider:()=>({authenticate:mocks.authenticate})}));
vi.mock("@/lib/platforms/instagram-login",()=>({exchangeInstagramLoginCode:mocks.exchange}));
vi.mock("@/lib/channels/upsert",()=>({upsertChannels:mocks.upsert,assertChannelsAllowed:vi.fn()}));
vi.mock("@/lib/channels/subscribe",()=>({subscribeChannelWebhooks:vi.fn(),subscribeInstagramMessaging:vi.fn()}));
vi.mock("@/lib/settings/config",()=>({getConfig:async()=>"app"}));
process.env.JWT_SECRET="test-oauth-consent-secret-at-least-32-characters";
const channelId="48c72472-c266-4e02-a626-2b7db7fa877f";
const auth: SessionAuthContext={workspaceId:"workspace",userId:"user",sessionId:"session",authMethod:"session",scopes:[]};
const ref={workspaceId:auth.workspaceId,channelId};
beforeEach(()=>{
  vi.clearAllMocks();mocks.authenticateSession.mockResolvedValue(auth);mocks.consume.mockResolvedValue(undefined);mocks.finish.mockResolvedValue(undefined);mocks.decline.mockResolvedValue(undefined);
  mocks.authenticate.mockResolvedValue([{platformId:"account",displayName:"Account",tokens:{access_token:"page",user_access_token:"user"}}]);
  mocks.exchange.mockResolvedValue({igUserId:"account",messagingToken:"ig",expiresAt:new Date(1900000000000)});
});
for (const flow of ["instagram","instagram-login"] as const) {
  describe(`${flow} Insights callback`,()=>{
    function request(extra:Record<string,string>, differentAuth?:SessionAuthContext) {
      const {state,setCookie}=generateOAuthState(auth,flow,{kind:"insights",channelId,transport:flow==="instagram"?"facebook":"instagram_business"});
      if(differentAuth) mocks.authenticateSession.mockResolvedValue(differentAuth);
      const params=new URLSearchParams({state,...extra});
      return {state,req:new Request(`https://example.com/api/oauth/${flow}/callback?${params}`,{headers:{cookie:setCookie.split(";")[0]}})};
    }
    async function callback(req:Request) {
      const route=flow==="instagram"?await import("./instagram/callback/route"):await import("./instagram-login/callback/route");return route.GET(req);
    }
    it("finishes the bound channel and clears the OAuth cookie",async()=>{
      const {state,req}=request({code:"code",channel:"different",transport:"different",returnTo:"https://outside.example"});
      const response=await callback(req);
      expect(response.headers.get("location")).toBe(`https://example.com/insights?channel=${channelId}`);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(mocks.consume).toHaveBeenCalledWith(ref,auth,state,flow==="instagram"?"facebook":"instagram_business");
      expect(mocks.finish).toHaveBeenCalledWith(ref,auth,expect.any(Array),state);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
    it("validates a declined callback before persisting additional access required",async()=>{
      const {state,req}=request({error:"access_denied"});const response=await callback(req);
      expect(response.headers.get("location")).toBe(`https://example.com/insights?channel=${channelId}`);
      expect(mocks.decline).toHaveBeenCalledWith(ref,auth,state);
      expect(mocks.authenticate).not.toHaveBeenCalled();expect(mocks.exchange).not.toHaveBeenCalled();
    });
    it("rejects a declined callback from a different session",async()=>{
      const {req}=request({error:"access_denied"},{...auth,sessionId:"different"});const response=await callback(req);
      expect(response.headers.get("location")).toBe("https://example.com/channels?error=invalid_state");
      expect(mocks.consume).not.toHaveBeenCalled();expect(mocks.decline).not.toHaveBeenCalled();
    });
    it("requires session authentication also for an API key callback",async()=>{
      const {req}=request({code:"code"});mocks.authenticateSession.mockResolvedValue(null);const response=await callback(req);
      expect(response.headers.get("location")).toBe("https://example.com/login?redirect=/channels");
      expect(mocks.finish).not.toHaveBeenCalled();expect(mocks.consume).not.toHaveBeenCalled();
    });
    it("delegates an explicit Insights start to the shared consent service",async()=>{
      mocks.begin.mockResolvedValue(new Response(null,{status:302,headers:{Location:"https://provider.example"}}));
      const route=flow==="instagram"?await import("./instagram/route"):await import("./instagram-login/route");
      const response=await route.GET(new Request(`https://example.com/api/oauth/${flow}?purpose=insights&channel=${channelId}`));
      expect(response.status).toBe(302);expect(mocks.begin).toHaveBeenCalledWith(ref,auth);
    });
  });
}
