import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { SessionAuthContext } from "@/lib/auth";
vi.mock("@/lib/license/gate",()=>({requireFeature:vi.fn()}));
vi.mock("@/lib/settings/config",()=>({getConfig:async()=>"test-app"}));
vi.mock("./schedule",()=>({enqueueInsights:vi.fn(async()=>({queued:true,nextRetryAt:null}))}));
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let consent: typeof import("./consent");
let service: typeof import("./service");
let encrypt: typeof import("@/lib/crypto").encryptTokens;
let decrypt: typeof import("@/lib/crypto").decryptTokens;
const ws=randomUUID(), other=randomUUID(), channelId=randomUUID(), pageId=randomUUID();
const ref={workspaceId:ws,channelId};
const auth: SessionAuthContext={workspaceId:ws,userId:randomUUID(),sessionId:randomUUID(),authMethod:"session",scopes:[]};
async function start() {
  const response=await consent.beginInsightConsent(ref,auth);
  const url=new URL(response.headers.get("location")!);
  const state=url.searchParams.get("state")!;
  const {verifyOAuthState}=await import("@/lib/oauth/state");
  const purpose=verifyOAuthState(state,response.headers.get("set-cookie")!.split(";")[0],auth,"instagram");
  if(purpose.kind!=="insights") throw new Error("Expected Insights purpose");
  return {state,purpose};
}
beforeAll(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY="test-consent-encryption-key-at-least-32-characters";
  process.env.JWT_SECRET="test-consent-jwt-secret-at-least-32-characters";
  process.env.CRON_SECRET="test-consent-cron-secret-at-least-32-characters";
  process.env.APP_URL="http://localhost:3478";
  ({db}=await import("@/lib/db"));s=await import("@/db/schema");consent=await import("./consent");service=await import("./service");
  ({encryptTokens:encrypt,decryptTokens:decrypt}=await import("@/lib/crypto"));
  await db.insert(s.workspaces).values([{id:ws,name:"Consent",slug:ws},{id:other,name:"Other",slug:other}]);
  await db.insert(s.channels).values([
    {id:channelId,workspace_id:ws,platform:"instagram",platform_id:"account",webhook_secret:"test",token_encrypted:encrypt({access_token:"page",user_access_token:"fb-user",messaging_token:"ig-user"})},
    {id:pageId,workspace_id:ws,platform:"instagram",platform_id:"page-only",webhook_secret:"test",token_encrypted:encrypt({access_token:"page"})},
  ]);
});
afterAll(async()=>{await db.delete(s.workspaces).where(eq(s.workspaces.id,ws));await db.delete(s.workspaces).where(eq(s.workspaces.id,other));});
it("limits consent to the workspace channel and supported credentials",async()=>{
  await expect(consent.beginInsightConsent({workspaceId:other,channelId},auth)).rejects.toThrow();
  await expect(consent.beginInsightConsent(ref,{...auth,authMethod:"api_key"} as unknown as SessionAuthContext)).rejects.toThrow();
  const result=await consent.beginInsightConsent({workspaceId:ws,channelId:pageId},auth);
  expect(result.status).toBe(422);expect(await result.text()).toContain("Instagram Business Login");
  expect((await service.getInsightStatus({workspaceId:ws,channelId:pageId})).collectionMode).toBe("off");
});
it("consumes each context once and records denial without altering channel tokens",async()=>{
  const {state,purpose}=await start();
  await expect(consent.consumeInsightConsent(ref,{...auth,sessionId:randomUUID()},state,purpose.transport)).rejects.toThrow();
  await expect(consent.consumeInsightConsent(ref,auth,state,"instagram_business")).rejects.toThrow();
  await consent.consumeInsightConsent(ref,auth,state,purpose.transport);
  await expect(consent.consumeInsightConsent(ref,auth,state,purpose.transport)).rejects.toThrow();
  await consent.declineInsightConsent(ref,auth);
  expect(await service.getInsightStatus(ref)).toMatchObject({displayStatus:"additional_access_required",state:"missing_permission"});
  const ch=await db.query.channels.findFirst({where:and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId))});
  expect(decrypt(ch!.token_encrypted).messaging_token).toBe("ig-user");expect(ch!.status).toBe("active");
});
it("updates only the bound account and keeps the other login",async()=>{
  const {state,purpose}=await start();await consent.consumeInsightConsent(ref,auth,state,purpose.transport);
  await expect(consent.finishInsightConsent(ref,auth,[{platformId:"different",displayName:"Different",tokens:{access_token:"other"}}])).rejects.toThrow();
  await consent.finishInsightConsent(ref,auth,[{platformId:"account",displayName:"Account",tokens:{access_token:"new-page",user_access_token:"new-fb",expires_at:1900000000}},{platformId:"other-account",displayName:"Other",tokens:{access_token:"unused"}}]);
  const ch=await db.query.channels.findFirst({where:and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId))});
  expect(decrypt(ch!.token_encrypted)).toMatchObject({messaging_token:"ig-user",access_token:"new-page",user_access_token:"new-fb"});
  expect(ch!.token_expires_at?.getTime()).toBe(1900000000000);
  expect((await db.select().from(s.channels).where(eq(s.channels.workspace_id,ws))).length).toBe(2);
  expect(await service.getInsightStatus(ref)).toMatchObject({displayStatus:"checking",state:"unknown"});
  await expect(consent.finishInsightConsent(ref,auth,[{platformId:"account",displayName:"Account",tokens:{access_token:"new"}}])).rejects.toThrow();
});
it("leaves a callback inactive after collection off and on or a credential replacement",async()=>{
  let context=await start();await consent.consumeInsightConsent(ref,auth,context.state,context.purpose.transport);
  await service.setCollectionMode(ref,"off");await service.setCollectionMode(ref,"on");
  await expect(consent.finishInsightConsent(ref,auth,[{platformId:"account",displayName:"Account",tokens:{access_token:"unused"}}])).rejects.toThrow();
  context=await start();await consent.consumeInsightConsent(ref,auth,context.state,context.purpose.transport);
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"replacement",user_access_token:"reconnected"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  await expect(consent.finishInsightConsent(ref,auth,[{platformId:"account",displayName:"Account",tokens:{access_token:"unused"}}])).rejects.toThrow();
});
it("retains evidence for the other transport and clears selected evidence on credential rotation",async()=>{
  const {insightCredentialRevision}=await import("./credentials");
  const {reconcileInsightCredentials}=await import("./lifecycle");
  const {resolveInsightCredential}=await import("./credentials");
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"page",user_access_token:"fb-current",messaging_token:"ig-current"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  await service.setCollectionMode(ref,"on");
  const fb=insightCredentialRevision("facebook","fb-current"),ig=insightCredentialRevision("instagram_business","ig-current");
  const checkedAt=new Date().toISOString();
  await db.update(s.insightConnections).set({transport:"facebook",credential_revision:fb,access_state:"ready",fb_grants:{version:1,revision:fb,names:["instagram_manage_insights"],checkedAt},ig_grants:{version:1,revision:ig,names:["instagram_business_manage_insights"],checkedAt}}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId)));
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"page",user_access_token:"fb-next",messaging_token:"ig-current"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  expect(await reconcileInsightCredentials(ref)).toBe(true);
  const connection=await db.query.insightConnections.findFirst({where:and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId))});
  expect(connection).toMatchObject({access_state:"unknown",credential_revision:null,fb_grants:{revision:null},ig_grants:{revision:ig}});
  expect((await resolveInsightCredential(ref,"instagram_business"))?.revision).toBe(ig);
});
it("completes Instagram Business Login through its signed callback and preserves Facebook",async()=>{
  const {insightCredentialRevision}=await import("./credentials");
  const ig=insightCredentialRevision("instagram_business","ig-current");
  await db.update(s.insightConnections).set({transport:"instagram_business",credential_revision:ig,access_state:"missing_permission"}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId)));
  const response=await consent.beginInsightConsent(ref,auth);
  const state=new URL(response.headers.get("location")!).searchParams.get("state")!;
  const cookie=response.headers.get("set-cookie")!.split(";")[0];
  const {verifyOAuthState}=await import("@/lib/oauth/state");
  expect(verifyOAuthState(state,cookie,auth,"instagram-login")).toMatchObject({transport:"instagram_business"});
  await consent.consumeInsightConsent(ref,auth,state,"instagram_business");
  await consent.finishInsightConsent(ref,auth,[{platformId:"account",displayName:"Account",tokens:{access_token:"",messaging_token:"ig-renewed",messaging_token_expires_at:1900000000}}],state);
  const ch=await db.query.channels.findFirst({where:and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId))});
  expect(decrypt(ch!.token_encrypted)).toMatchObject({access_token:"page",user_access_token:"fb-next",messaging_token:"ig-renewed"});
  expect(ch!.messaging_token_expires_at?.getTime()).toBe(1900000000000);
});
it("keeps source ownership and channel context when renewing a derived credential",async()=>{
  const sourceId=randomUUID(), derivedId=randomUUID();
  await db.insert(s.accountSources).values({id:sourceId,workspace_id:ws,provider:"meta",provider_account_id:"source-user",kind:"user",token_encrypted:encrypt({access_token:"source-before"})});
  await db.insert(s.channels).values({id:derivedId,workspace_id:ws,platform:"instagram",platform_id:"derived-account",connection_mode:"derived",source_id:sourceId,token_encrypted:encrypt({access_token:"derived-page",messaging_token:"derived-ig"}),webhook_secret:"test"});
  const derivedRef={workspaceId:ws,channelId:derivedId};
  const response=await consent.beginInsightConsent(derivedRef,auth);
  const state=new URL(response.headers.get("location")!).searchParams.get("state")!;
  await consent.consumeInsightConsent(derivedRef,auth,state,"facebook");
  // GET /me documented identity shape; provider calls stay offline.
  const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({id:"different-user"}));
  const accounts=[{platformId:"derived-account",displayName:"Derived",tokens:{access_token:"derived-page-new",user_access_token:"source-new"}}];
  try {
    await expect(consent.finishInsightConsent(derivedRef,auth,accounts,state)).rejects.toThrow("Use the Meta User");
    fetchMock.mockResolvedValue(Response.json({id:"source-user"}));
    await consent.finishInsightConsent(derivedRef,auth,accounts,state);
    const source=await db.query.accountSources.findFirst({where:and(eq(s.accountSources.workspace_id,ws),eq(s.accountSources.id,sourceId))});
    expect(decrypt(source!.token_encrypted).access_token).toBe("source-new");
    const channel=await db.query.channels.findFirst({where:and(eq(s.channels.workspace_id,ws),eq(s.channels.id,derivedId))});
    expect(channel).toMatchObject({connection_mode:"derived",source_id:sourceId});
    expect(decrypt(channel!.token_encrypted).messaging_token).toBe("derived-ig");
  } finally { fetchMock.mockRestore(); }
});
it("renews the existing User source when its credential requires reauthentication",async()=>{
  const sourceId=randomUUID(), derivedId=randomUUID();
  await db.insert(s.accountSources).values({id:sourceId,workspace_id:ws,provider:"meta",provider_account_id:"renewing-source-user",kind:"user",status:"needs_reauth",token_encrypted:encrypt({access_token:"expired-source"})});
  await db.insert(s.channels).values({id:derivedId,workspace_id:ws,platform:"instagram",platform_id:"renewing-derived-account",connection_mode:"derived",source_id:sourceId,status:"needs_reauth",token_encrypted:encrypt({access_token:"old-derived-page"}),webhook_secret:"test"});
  const derivedRef={workspaceId:ws,channelId:derivedId};
  const response=await consent.beginInsightConsent(derivedRef,auth);
  expect(response.status).toBe(302);
  const state=new URL(response.headers.get("location")!).searchParams.get("state")!;
  await consent.consumeInsightConsent(derivedRef,auth,state,"facebook");
  const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({id:"renewing-source-user"}));
  try {
    await consent.finishInsightConsent(derivedRef,auth,[{platformId:"renewing-derived-account",displayName:"Derived",tokens:{access_token:"new-derived-page",user_access_token:"new-source-user"}}],state);
    const channel=await db.query.channels.findFirst({where:and(eq(s.channels.workspace_id,ws),eq(s.channels.id,derivedId))});
    expect(channel).toMatchObject({status:"active",source_id:sourceId,connection_mode:"derived"});
    expect(await service.getInsightStatus(derivedRef)).toMatchObject({displayStatus:"checking",reason:"first_sync"});
  } finally {fetchMock.mockRestore();}
});
it("checks a renewed credential after an earlier declined consent",async()=>{
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"page",user_access_token:"before-decline"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  await db.update(s.insightConnections).set({transport:"facebook",credential_revision:null,access_state:"unknown"}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId)));
  const {state,purpose}=await start();await consent.consumeInsightConsent(ref,auth,state,purpose.transport);await consent.declineInsightConsent(ref,auth,state);
  expect((await service.getInsightStatus(ref)).displayStatus).toBe("additional_access_required");
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"page",user_access_token:"after-decline"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  const {reconcileInsightCredentials}=await import("./lifecycle");expect(await reconcileInsightCredentials(ref)).toBe(true);
  expect((await service.getInsightStatus(ref)).displayStatus).toBe("checking");
});
