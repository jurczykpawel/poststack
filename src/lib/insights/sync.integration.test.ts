import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
vi.mock("@/lib/license/gate",()=>({requireFeature:vi.fn()}));
let db:typeof import("@/lib/db").db;
let s:typeof import("@/db/schema");
let sync:typeof import("./sync");
let schedule:typeof import("./schedule");
let service:typeof import("./service");
let encrypt:typeof import("@/lib/crypto").encryptTokens;
const ws=randomUUID(), ids=[randomUUID(),randomUUID(),randomUUID()];
const ref={workspaceId:ws,channelId:ids[0]};
const scope=()=>and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,ids[0]));
const fetcher=vi.fn<import("./types").InsightsConnector["fetch"]>();
let revision:string;
beforeAll(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY="test-insights-encryption-passphrase-32characters";
  process.env.JWT_SECRET="test-jwt-secret-at-least-32-characters";
  ({db}=await import("@/lib/db"));s=await import("@/db/schema");sync=await import("./sync");schedule=await import("./schedule");service=await import("./service");
  ({encryptTokens:encrypt}=await import("@/lib/crypto"));
  revision=(await import("./credentials")).insightCredentialRevision("facebook","test-user-token");
  const {instagramInsightsConnector}=await import("./instagram/transport");
  vi.spyOn(instagramInsightsConnector,"fetch").mockImplementation(fetcher);
  await db.insert(s.workspaces).values({id:ws,name:"Worker",slug:ws});
  await db.insert(s.channels).values(ids.map((id,i)=>({id,workspace_id:ws,platform:"instagram" as const,platform_id:`account${i}`,webhook_secret:"test",token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"test-user-token"})})));
});
beforeEach(async()=>{
  const {requireFeature}=await import("@/lib/license/gate");vi.mocked(requireFeature).mockReset();
  fetcher.mockReset().mockResolvedValue({observations:[],usage:{percent:null,regainAfterSeconds:null}});
  await db.delete(s.insightConnections).where(eq(s.insightConnections.workspace_id,ws));
  await db.delete(s.insightObservations).where(eq(s.insightObservations.workspace_id,ws));
  await db.execute(sql`select graphile_worker.remove_job(key) from graphile_worker._private_jobs where payload->>'workspaceId' = ${ws}`);
  await db.update(s.channels).set({status:"active",deleted_at:null,token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"test-user-token"})}).where(eq(s.channels.workspace_id,ws));
  for(const channelId of ids) await service.setCollectionMode({workspaceId:ws,channelId},"on");
});
afterAll(async()=>{await db.delete(s.workspaces).where(eq(s.workspaces.id,ws));vi.restoreAllMocks();});
it("deduplicates concurrent refresh and carries only reference/revision in a low priority lane",async()=>{
  await Promise.all([schedule.enqueueInsights(ref,"refresh"),schedule.enqueueInsights(ref,"refresh")]);
  const jobs=await db.execute(sql`select * from graphile_worker._private_jobs where payload->>'workspaceId'=${ws}`);
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0]).toMatchObject({priority:100});
  expect(Object.keys(jobs.rows[0].payload as object).sort()).toEqual(["channelId","credentialRevision","workspaceId"]);
  expect(await schedule.enqueueInsights(ref,"refresh")).toMatchObject({queued:false});
});
it("counts 120 failed and successful attempts together across related channels",async()=>{
  const recent=new Date().toISOString();
  await db.update(s.insightConnections).set({budget_key:"meta:unidentified-user",usage_budget:{version:1,requestTimes:Array(119).fill(recent),nextSafeAt:null}}).where(scope());
  fetcher.mockRejectedValue({kind:"rate_limited",retryAfterSeconds:120});
  await sync.processInsightsSync(ref);
  await sync.processInsightsSync({workspaceId:ws,channelId:ids[1]});
  expect(fetcher).toHaveBeenCalledTimes(1);
  const rows=await db.select().from(s.insightConnections).where(eq(s.insightConnections.workspace_id,ws));
  expect(rows.flatMap(r=>r.usage_budget.requestTimes)).toHaveLength(120);
  expect(rows.find(r=>r.channel_id===ids[1])?.next_due_at.getTime()).toBeGreaterThan(Date.now());
});
it("serializes one channel and stops after collection is switched off in flight",async()=>{
  let release!:()=>void;let started!:()=>void;
  const entered=new Promise<void>(r=>{started=r;});const wait=new Promise<void>(r=>{release=r;});
  fetcher.mockImplementation(async()=>{started();await wait;return {observations:[],usage:{percent:null,regainAfterSeconds:null}};});
  const first=sync.processInsightsSync(ref);await entered;
  await sync.processInsightsSync(ref);
  await service.setCollectionMode(ref,"off");release();await first;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [row]=await db.select().from(s.insightConnections).where(scope());
  expect(row).toMatchObject({collection_mode:"off",access_state:"unknown",claim_token:null});
});
it.each(["paused","deleted","free","permission"])("does no HTTP after queued channel becomes %s",async(kind)=>{
  await schedule.enqueueInsights(ref,"enable");
  if(kind==="paused") await db.update(s.channels).set({status:"paused"}).where(eq(s.channels.id,ids[0]));
  if(kind==="deleted") await db.update(s.channels).set({deleted_at:new Date()}).where(eq(s.channels.id,ids[0]));
  if(kind==="free") {const {requireFeature}=await import("@/lib/license/gate");vi.mocked(requireFeature).mockRejectedValue(new Error("locked"));}
  if(kind==="permission") await db.update(s.insightConnections).set({access_state:"missing_permission",credential_revision:revision}).where(scope());
  await sync.processInsightsSync(ref);expect(fetcher).not.toHaveBeenCalled();
});
it.each(["reconnect","downgrade"])("discards an in-flight response after %s and sends no next request",async(kind)=>{
  fetcher.mockImplementationOnce(async()=>{
    if(kind==="reconnect") await db.update(s.channels).set({token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"changed-user-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,ids[0])));
    else {const {requireFeature}=await import("@/lib/license/gate");vi.mocked(requireFeature).mockRejectedValue(new Error("locked"));}
    return {observations:[],usage:{percent:null,regainAfterSeconds:null}};
  });
  await sync.processInsightsSync(ref);expect(fetcher).toHaveBeenCalledTimes(1);
  const [row]=await db.select().from(s.insightConnections).where(scope());expect(row.access_state).toBe("unknown");expect(row.fb_grants.revision).toBeNull();expect(row.ig_grants.revision).toBeNull();
});
it("limits each job, resumes durable history, and recovers an expired claim via the sweep",async()=>{
  await sync.processInsightsSync(ref);expect(fetcher).toHaveBeenCalledTimes(10);
  const [first]=await db.select().from(s.insightConnections).where(scope());
  expect(first.checkpoint.cursor).toBeDefined();
  await db.update(s.insightConnections).set({next_due_at:new Date(0),claim_token:randomUUID(),claim_until:new Date(0)}).where(scope());
  await schedule.sweepInsights();
  await sync.processInsightsSync(ref);
  expect(fetcher.mock.calls[16][1].to).toBe(schedule.readSyncCursor(first.checkpoint).before);
  expect(fetcher).toHaveBeenCalledTimes(20);
});
it("usage eighty stops the next request and preserves at least a fifteen minute floor",async()=>{
  fetcher.mockResolvedValue({observations:[],usage:{percent:80,regainAfterSeconds:120}});
  const before=Date.now();await sync.processInsightsSync(ref);expect(fetcher).toHaveBeenCalledTimes(1);
  const [row]=await db.select().from(s.insightConnections).where(scope());expect(row.next_due_at.getTime()).toBeGreaterThanOrEqual(before+900000);
});
it("bounds automatic unknown failures to three without resetting refresh backoff",async()=>{
  fetcher.mockRejectedValue({kind:"unknown",retryAfterSeconds:null});
  for(let n=0;n<4;n++) {
    await db.update(s.insightConnections).set({next_due_at:new Date(0),backoff_until:null,usage_budget:sql`jsonb_set(${s.insightConnections.usage_budget}, '{nextSafeAt}', 'null'::jsonb)`}).where(scope());
    await sync.processInsightsSync(ref);
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("remembers unsupported singleton recipes for the selected revision",async()=>{
  const {instagramInsightsConnector}=await import("./instagram/transport");
  const original=instagramInsightsConnector.catalog();
  const catalog=vi.spyOn(instagramInsightsConnector,"catalog").mockReturnValue([...original,{...original[0],key:"test_metric"}]);
  fetcher.mockImplementation(async(_credential,query)=>{
    if(query.metrics.includes("test_metric")) throw {kind:"unsupported_metric",retryAfterSeconds:null};
    return {observations:[],usage:{percent:null,regainAfterSeconds:null}};
  });
  try {
    await sync.processInsightsSync(ref);
    const [row]=await db.select().from(s.insightConnections).where(scope());
    expect(schedule.readSyncCursor(row.checkpoint).unsupported).toEqual(["test_metric"]);
    expect(row.access_state).toBe("ready");
    fetcher.mockClear();
    await db.update(s.insightConnections).set({next_due_at:new Date(0)}).where(scope());
    await sync.processInsightsSync(ref);
    expect(fetcher.mock.calls.every(([,q])=>!q.metrics.includes("test_metric"))).toBe(true);
  } finally {catalog.mockRestore();}
});
it("runs two background lanes across worker runners and serializes each lane",async()=>{
  const {run}=await import("graphile-worker");
  const {addJobTx}=await import("@/lib/queue/client");
  let active=0,peak=0;const byChannel=new Map<string,number>();
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});
  let two!:()=>void;const entered=new Promise<void>(r=>{two=r;});
  fetcher.mockImplementation(async(credential)=>{
    active++;peak=Math.max(peak,active);byChannel.set(credential.accountKey,(byChannel.get(credential.accountKey)??0)+1);
    if(active===2) two();
    await hold;
    active--;
    return {observations:[],usage:{percent:90,regainAfterSeconds:null}};
  });
  for(let i=0;i<ids.length;i++) await addJobTx(db,"insights-sync",{workspaceId:ws,channelId:ids[i]},{jobKey:`lanes:${ws}:${i}`,queueName:`insights:${i%2}`,priority:100});
  const options={connectionString:process.env.TEST_DATABASE_URL!,concurrency:4,pollInterval:50,noHandleSignals:true,taskList:{"insights-sync":(p:unknown)=>sync.processInsightsSync(p as import("@/lib/queue/types").InsightsSyncJob)}};
  const runners=await Promise.all([run(options),run(options)]);
  try {
    await entered;expect(peak).toBe(2);expect([...byChannel.values()].every(n=>n===1)).toBe(true);
    release();
    await vi.waitFor(async()=>{
      const jobs=await db.execute(sql`select id from graphile_worker._private_jobs where payload->>'workspaceId'=${ws}`);
      expect(jobs.rows).toHaveLength(0);
    });
    expect(peak).toBe(2);
  } finally {release();await Promise.all(runners.map(r=>r.stop()));}
});
it("applies singleton usage before attempting the next metric",async()=>{
  const {instagramInsightsConnector}=await import("./instagram/transport");
  const original=instagramInsightsConnector.catalog();
  const catalog=vi.spyOn(instagramInsightsConnector,"catalog").mockReturnValue([...original,{...original[0],key:"test_metric"}]);
  fetcher.mockImplementation(async(_credential,query)=>{
    if(query.metrics.length>1) throw {kind:"unsupported_metric",retryAfterSeconds:null};
    return {observations:[],usage:{percent:90,regainAfterSeconds:null}};
  });
  try {await sync.processInsightsSync(ref);expect(fetcher).toHaveBeenCalledTimes(2);}
  finally {catalog.mockRestore();}
});
async function documentedBatch():Promise<import("./types").InsightBatch> {
  const fixture=await import("./__fixtures__/instagram/account-series.json");
  const {parseInsightJson}=await import("./instagram/json");
  const {parseInstagramInsights}=await import("./instagram/parser");
  const {instagramCatalog}=await import("./instagram/catalog");
  const query={level:"account" as const,subjectKey:"account0",grain:"day" as const,metrics:["reach"],from:"2018-01-10T08:00:00Z",to:"2018-01-12T08:00:00Z"};
  return {usage:{percent:null,regainAfterSeconds:null},observations:parseInstagramInsights(parseInsightJson(fixture.responseText),query,{platform:"instagram",level:"account",subjectKey:"account0",grain:"day",period:"day",metricType:"time_series",windowStart:query.from,windowEnd:query.to,snapshotDay:"2018-01-10",fetchedAt:new Date().toISOString(),providerDay:null,boundaryBasis:"provider_end_time",transport:"facebook",apiVersion:"v26.0",queryParams:{metric:"reach"},definitionVersion:instagramCatalog[0].definitionVersion,coverageBasis:instagramCatalog[0].coverageBasis})};
}
it("commits documented observations and checkpoint together and preserves progress during retention",async()=>{
  const batch=await documentedBatch();const claim=randomUUID();
  await db.update(s.insightConnections).set({transport:"facebook",credential_revision:revision,claim_token:claim,claim_until:new Date(Date.now()+180000)}).where(scope());
  await expect(service.storeInsightBatch(ref,revision,batch,claim,{checkpoint:{version:1,cursor:""},next_due_at:new Date()})).rejects.toThrow();
  expect(await db.select().from(s.insightObservations).where(eq(s.insightObservations.workspace_id,ws))).toHaveLength(0);
  const checkpoint=schedule.syncCheckpoint({version:1},"2018-01-10T08:00:00Z",revision,[]);
  expect(await service.storeInsightBatch(ref,revision,batch,claim,{checkpoint,next_due_at:new Date()})).toBe(2);
  const {pruneInsights}=await import("./repository");
  expect(await pruneInsights(ws,new Date())).toBe(2);
  const [row]=await db.select().from(s.insightConnections).where(scope());expect(row.checkpoint).toEqual(checkpoint);
});
it("shares source budget across derived channels",async()=>{
  const sourceId=randomUUID();
  await db.insert(s.accountSources).values({id:sourceId,workspace_id:ws,provider:"meta",provider_account_id:sourceId,kind:"user",token_encrypted:encrypt({access_token:"test-user-token"})});
  await db.update(s.channels).set({source_id:sourceId}).where(eq(s.channels.workspace_id,ws));
  try {
    await schedule.enqueueInsights(ref,"enable");
    await schedule.enqueueInsights({workspaceId:ws,channelId:ids[1]},"enable");
    fetcher.mockRejectedValue({kind:"rate_limited",retryAfterSeconds:172800});
    await sync.processInsightsSync(ref);
    await sync.processInsightsSync({workspaceId:ws,channelId:ids[1]});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const rows=await db.select().from(s.insightConnections).where(eq(s.insightConnections.workspace_id,ws));
    expect(rows.filter(r=>r.budget_key===`meta-source:${sourceId}`)).toHaveLength(2);
    expect(rows.find(r=>r.channel_id===ids[1])?.backoff_until?.getTime()).toBeGreaterThan(Date.now()+86400000);
  } finally {
    await db.update(s.channels).set({source_id:null}).where(eq(s.channels.workspace_id,ws));
    await db.delete(s.accountSources).where(and(eq(s.accountSources.workspace_id,ws),eq(s.accountSources.id,sourceId)));
  }
});
it("returns the shared retry floor for a manual refresh on another derived channel",async()=>{
  const until=new Date(Date.now()+172800000);
  await db.update(s.insightConnections).set({budget_key:"meta:unidentified-user",backoff_until:until}).where(scope());
  expect(await schedule.enqueueInsights({workspaceId:ws,channelId:ids[1]},"refresh")).toEqual({queued:false,nextRetryAt:until.toISOString()});
  expect(fetcher).not.toHaveBeenCalled();
});
it("keeps a newly selected login when consent changes before the worker claim",async()=>{
  const credentials=await import("./credentials");const original=credentials.resolveInsightCredential;
  const lifecycle=await import("./lifecycle");const reconcileOriginal=lifecycle.reconcileInsightCredentials;
  const selected=credentials.insightCredentialRevision("instagram_business","test-ig-token");
  // The consent change lands after the credential reconcile transaction commits: writing the rows it
  // holds from inside that transaction's own resolver call would wait on itself.
  let reconciled=false, changed=false;
  const reconcile=vi.spyOn(lifecycle,"reconcileInsightCredentials").mockImplementation(async(...args)=>{const value=await reconcileOriginal(...args);reconciled=true;return value;});
  const resolver=vi.spyOn(credentials,"resolveInsightCredential").mockImplementation(async(...args)=>{
    const value=await original(...args);
    if(!reconciled || changed) return value;
    changed=true;
    await db.update(s.channels).set({token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"test-user-token",messaging_token:"test-ig-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,ids[0])));
    await db.update(s.insightConnections).set({transport:"instagram_business",credential_revision:selected,access_state:"unknown"}).where(scope());
    return value;
  });
  try {
    await sync.processInsightsSync(ref);expect(changed).toBe(true);expect(fetcher).not.toHaveBeenCalled();
    const [row]=await db.select().from(s.insightConnections).where(scope());
    expect(row).toMatchObject({transport:"instagram_business",credential_revision:selected});
  } finally {resolver.mockRestore();reconcile.mockRestore();}
});
it("enqueues the selected login when both credentials are present",async()=>{
  const selected=(await import("./credentials")).insightCredentialRevision("instagram_business","test-ig-token");
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"test-user-token",messaging_token:"test-ig-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,ids[0])));
  await db.update(s.insightConnections).set({transport:"instagram_business",credential_revision:selected}).where(scope());
  await schedule.enqueueInsights(ref,"consent");
  const jobs=await db.execute(sql`select payload from graphile_worker._private_jobs where payload->>'workspaceId'=${ws}`);
  expect(jobs.rows[0].payload).toMatchObject({credentialRevision:selected});
});
it.each(["new","same"])("defers re-consent with exhausted unknown attempts for a %s credential",async(kind)=>{
  for(const channelId of ids.slice(1)) await service.setCollectionMode({workspaceId:ws,channelId},"off");
  fetcher.mockRejectedValue({kind:"unknown",retryAfterSeconds:null});
  for(let n=0;n<3;n++) {
    await db.update(s.insightConnections).set({next_due_at:new Date(0),backoff_until:null,usage_budget:sql`jsonb_set(${s.insightConnections.usage_budget}, '{nextSafeAt}', 'null'::jsonb)`}).where(scope());
    await sync.processInsightsSync(ref);
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
  const [failed]=await db.select().from(s.insightConnections).where(scope());
  if(kind==="new") await db.update(s.channels).set({token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"new-consent-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,ids[0])));
  const until=new Date(Date.now()+1000);
  const budget={...failed.usage_budget,nextSafeAt:until.toISOString()};
  await db.update(s.insightConnections).set({credential_revision:null,access_state:"unknown",failure_count:3,next_due_at:new Date(0),backoff_until:until,usage_budget:budget}).where(scope());
  expect(await schedule.enqueueInsights(ref,"consent")).toEqual({queued:false,nextRetryAt:until.toISOString()});
  await schedule.sweepInsights();
  const [deferred]=await db.select().from(s.insightConnections).where(scope());
  expect(deferred.usage_budget).toEqual(budget);expect(deferred.backoff_until).toEqual(until);expect(deferred.failure_count).toBe(3);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.waitFor(()=>expect(Date.now()).toBeGreaterThanOrEqual(until.getTime()),{interval:25,timeout:5000});
  fetcher.mockClear().mockResolvedValue({observations:[],usage:{percent:80,regainAfterSeconds:null}});
  await schedule.sweepInsights();
  const jobs=await db.execute(sql`select payload from graphile_worker._private_jobs where payload->>'workspaceId'=${ws} and payload->>'channelId'=${ids[0]}`);
  expect(jobs.rows).toHaveLength(kind==="new"?1:0);
  await sync.processInsightsSync(ref);
  expect(fetcher).toHaveBeenCalledTimes(kind==="new"?1:0);
  const [after]=await db.select().from(s.insightConnections).where(scope());
  expect(after.usage_budget.requestTimes.slice(0,3)).toEqual(budget.requestTimes);
  if(kind==="new") expect(after).toMatchObject({access_state:"ready",failure_count:0});
});

it("persists an HTTP permission denial and stops subsequent sync attempts",async()=>{
  const {instagramInsightsConnector}=await import("./instagram/transport");
  const real=vi.mocked(instagramInsightsConnector.fetch).getMockImplementation();
  vi.mocked(instagramInsightsConnector.fetch).mockRestore();
  const http=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({error:{code:10,type:"IGApiException",message:"Application does not have permission for this action"}}),{status:403}));
  vi.stubGlobal("fetch",http);
  try {
    await db.update(s.channels).set({token_encrypted:encrypt({access_token:"test-ig-token",messaging_token:"test-ig-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,ids[0])));
    await sync.processInsightsSync(ref);
    const [row]=await db.select().from(s.insightConnections).where(scope());
    expect(row).toMatchObject({access_state:"missing_permission",reason:"permission_required",failure_count:1});
    expect(await service.getInsightStatus(ref)).toMatchObject({displayStatus:"additional_access_required",state:"missing_permission"});
    await db.update(s.insightConnections).set({next_due_at:new Date(0),backoff_until:null,usage_budget:sql`jsonb_set(${s.insightConnections.usage_budget}, '{nextSafeAt}', 'null'::jsonb)`}).where(scope());
    expect(await schedule.enqueueInsights(ref,"refresh")).toEqual({queued:false,nextRetryAt:null});
    await sync.processInsightsSync(ref);
    expect(http).toHaveBeenCalledTimes(1);
    expect(row.ig_grants).toEqual({version:1,names:[],checkedAt:null,revision:null});
  } finally {
    vi.unstubAllGlobals();
    vi.spyOn(instagramInsightsConnector,"fetch").mockImplementation(real!);
  }
});

it.each([
  ["facebook", ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"]],
  ["instagram_business", ["instagram_business_basic", "instagram_business_manage_insights"]],
] as const)("records independent %s grant evidence after a successful Insights request",async(transport,names)=>{
  const {insightCredentialRevision}=await import("./credentials");
  const other={version:1 as const,names:["other_permission"],checkedAt:new Date().toISOString(),revision:insightCredentialRevision(transport==="facebook"?"instagram_business":"facebook",transport==="facebook"?"test-ig-token":"test-user-token")};
  await db.update(s.channels).set({token_encrypted:encrypt({access_token:"test-page-token",user_access_token:"test-user-token",messaging_token:"test-ig-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,ids[0])));
  await db.update(s.insightConnections).set({transport,...(transport==="facebook"?{ig_grants:other}:{fb_grants:other})}).where(scope());
  fetcher.mockResolvedValue({observations:[],usage:{percent:80,regainAfterSeconds:null}});
  const before=Date.now();
  await sync.processInsightsSync(ref);
  const [row]=await db.select().from(s.insightConnections).where(scope());
  const evidence=transport==="facebook"?row.fb_grants:row.ig_grants;
  expect(row.access_state).toBe("ready");
  expect(evidence).toMatchObject({version:1,names:[...names],revision:insightCredentialRevision(transport,transport==="facebook"?"test-user-token":"test-ig-token")});
  expect(Date.parse(evidence.checkedAt!)).toBeGreaterThanOrEqual(before);
  expect(evidence.checkedAt).toBe(row.access_checked_at?.toISOString());
  expect(transport==="facebook"?row.ig_grants:row.fb_grants).toEqual(other);
});
it("keeps daily collection available when a range recipe is unavailable",async()=>{
  fetcher.mockImplementation(async(_credential,query)=>{
    if(query.grain==="range") throw {kind:"unsupported_metric",retryAfterSeconds:null};
    return {observations:[],usage:{percent:null,regainAfterSeconds:null}};
  });
  await sync.processInsightsSync(ref);
  expect(fetcher).toHaveBeenCalledTimes(10);
  expect(fetcher.mock.calls.filter(([,q])=>q.grain==="range")).toHaveLength(2);
  const [row]=await db.select().from(s.insightConnections).where(scope());
  expect(row.access_state).toBe("ready");
  expect(schedule.readSyncCursor(row.checkpoint).unsupported).toEqual([]);
});
it("applies the shared usage floor before moving from ranges to history",async()=>{
  fetcher.mockImplementation(async(_credential,query)=>({observations:[],usage:{percent:query.grain==="range"?90:null,regainAfterSeconds:null}}));
  await sync.processInsightsSync(ref);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls.at(-1)![1].grain).toBe("range");
  const [row]=await db.select().from(s.insightConnections).where(scope());
  expect(schedule.readSyncCursor(row.checkpoint).before).toBeUndefined();
  expect(row.reason).toBe("none");
  expect(row.backoff_until!.getTime()).toBeGreaterThan(Date.now()+3590000);
});
