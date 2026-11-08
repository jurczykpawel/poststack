import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/license/gate",()=>({requireFeature:vi.fn()}));
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let service: typeof import("./service");
let repo: typeof import("./repository");
let revision: string;
const ws=randomUUID(), other=randomUUID(), channelId=randomUUID();
const ref={workspaceId:ws,channelId};
beforeAll(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY="test-insights-encryption-passphrase-32characters";
  process.env.JWT_SECRET="test-jwt-secret-at-least-32-characters";
  ({db}=await import("@/lib/db")); s=await import("@/db/schema"); service=await import("./service"); repo=await import("./repository");
  const {encryptTokens}=await import("@/lib/crypto");
  const {insightCredentialRevision}=await import("./credentials"); revision=insightCredentialRevision("facebook","test-user-token");
  await db.insert(s.workspaces).values([{id:ws,name:"Insights",slug:ws},{id:other,name:"Other",slug:other}]);
  await db.insert(s.channels).values({id:channelId,workspace_id:ws,platform:"instagram",platform_id:"account",webhook_secret:"test",token_encrypted:encryptTokens({access_token:"test-page-token",user_access_token:"test-user-token"})});
});
afterAll(async()=>{await db.delete(s.workspaces).where(eq(s.workspaces.id,ws)); await db.delete(s.workspaces).where(eq(s.workspaces.id,other));});
it("stores corrections, preserves successful values, scopes reads/mutations and prunes bounded UTC dates",async()=>{
  await service.setCollectionMode(ref,"on");
  await db.update(s.insightConnections).set({transport:"facebook",credential_revision:revision}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId)));
  const {instagramCatalog}=await import("./instagram/catalog");
  const observation: import("./types").InsightObservation={platform:"instagram",metricKey:"reach",level:"account",subjectKey:"account",grain:"day",period:"day",metricType:"time_series",windowStart:"2026-01-01T08:00:00Z",windowEnd:"2026-01-02T08:00:00Z",snapshotDay:"2026-01-01",providerDay:"2026-01-01",boundaryBasis:"provider_end_time",fetchedAt:"2026-01-04T00:00:00Z",value:"9007199254740993",state:"available",dimensions:{},queryParams:{metric:"reach"},transport:"facebook",apiVersion:"v26.0",definitionVersion:instagramCatalog[0].definitionVersion,coverageBasis:"provider_end_time"};
  const batch=(overrides:Partial<typeof observation>={})=>({observations:[{...observation,...overrides}],usage:{percent:null,regainAfterSeconds:null}});
  expect(await service.storeInsightBatch(ref,"old",batch())).toBe(0);
  expect((await service.getInsightStatus(ref)).state).toBe("unknown");
  expect(await service.storeInsightBatch(ref,revision,batch())).toBe(1);
  expect(await service.storeInsightBatch(ref,revision,batch({value:"3",fetchedAt:"2026-01-03T00:00:00Z"}))).toBe(0);
  expect(await service.storeInsightBatch(ref,revision,{observations:[],usage:{percent:null,regainAfterSeconds:null}})).toBe(0);
  expect(await service.storeInsightBatch(ref,revision,batch({value:null,state:"not_available",fetchedAt:"2026-01-05T00:00:00Z"}))).toBe(0);
  const query={level:"account" as const,subjectKey:"account",grain:"day" as const,metrics:["reach"],from:observation.windowStart,to:observation.windowEnd};
  expect((await service.readAccountInsights(ref,query)).series[0].value).toBe("9007199254740993");
  expect(await repo.readObservations({workspaceId:other,channelId},query)).toEqual([]);
  await expect(service.setCollectionMode({workspaceId:other,channelId},"off")).rejects.toThrow();
  expect(await repo.pruneInsights(other,new Date("2028-01-01T00:00:00Z"))).toBe(0);
  await service.setCollectionMode(ref,"off");
  expect(await service.storeInsightBatch(ref,revision,batch({value:"4"}))).toBe(0);
  expect((await service.readAccountInsights(ref,query)).series[0].value).toBe("9007199254740993");
  expect(await repo.pruneInsights(ws,new Date("2027-02-05T00:00:00Z"))).toBe(0);
  expect(await repo.pruneInsights(ws,new Date("2027-02-06T00:00:00Z"),1)).toBe(1);
  expect(await db.select().from(s.insightConnections).where(eq(s.insightConnections.workspace_id,ws))).toHaveLength(1);
});
it("uses actual daily windows for corrections across overlapping fetches",async()=>{
  await service.setCollectionMode(ref,"on");
  await db.update(s.insightConnections).set({transport:"facebook",credential_revision:revision}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId)));
  const fixture=await import("./__fixtures__/instagram/account-series.json");
  const {parseInsightJson}=await import("./instagram/json");
  const {parseInstagramInsights}=await import("./instagram/parser");
  const {instagramCatalog}=await import("./instagram/catalog");
  const query={level:"account" as const,subjectKey:"account",grain:"day" as const,metrics:["reach"],from:"2018-01-10T08:00:00Z",to:"2018-01-12T08:00:00Z"};
  const observations=parseInstagramInsights(parseInsightJson(fixture.responseText),query,{platform:"instagram",level:"account",subjectKey:"account",grain:"day",period:"day",metricType:"time_series",windowStart:query.from,windowEnd:query.to,snapshotDay:"2018-01-10",fetchedAt:"2026-11-01T00:00:00Z",providerDay:null,boundaryBasis:"provider_end_time",transport:"facebook",apiVersion:"v26.0",queryParams:{metric:"reach",since:"1",until:"2"},definitionVersion:instagramCatalog[0].definitionVersion,coverageBasis:instagramCatalog[0].coverageBasis});
  const batch={observations,usage:{percent:null,regainAfterSeconds:null}};
  expect(await service.storeInsightBatch(ref,revision,batch)).toBe(2);
  const corrected=observations.map(o=>({...o,fetchedAt:"2026-11-02T00:00:00Z",queryParams:{until:"4",since:"0",metric:"reach"},value:"0"}));
  expect(await service.storeInsightBatch(ref,revision,{...batch,observations:corrected})).toBe(2);
  const stored=await repo.readObservations(ref,query);
  expect(stored).toHaveLength(2); expect(stored.every(o=>o.value==="0")).toBe(true);
  const report=await service.readAccountInsights(ref,query);
  expect(report.summary.find(m=>m.metricKey==="reach")).toMatchObject({value:null,complete:false});
  expect(report.catalog.filter(m=>!m.active).every(m=>!!m.reason)).toBe(true);
  expect(report.series.every(o=>o.providerDay?.startsWith("2018-01-"))).toBe(true);
  const {encryptTokens}=await import("@/lib/crypto");
  await db.update(s.channels).set({token_encrypted:encryptTokens({access_token:"test-page-token",user_access_token:"new-user-token"})}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  expect(await service.storeInsightBatch(ref,revision,{...batch,observations:corrected.map(o=>({...o,value:"99",fetchedAt:"2026-11-03T00:00:00Z"}))})).toBe(0);
  expect((await repo.readObservations(ref,query)).every(o=>o.value==="0")).toBe(true);
});
it("retains UTC cutoff dates and range cache by fetch age in bounded batches",async()=>{
  await db.delete(s.insightObservations).where(eq(s.insightObservations.workspace_id,ws));
  const base={workspace_id:ws,channel_id:channelId,platform:"instagram" as const,metric_key:"reach",level:"account" as const,subject_key:"account",period:"day" as const,metric_type:"total_value" as const,window_start:new Date("2025-01-01T00:00:00Z"),window_end:new Date("2025-01-08T00:00:00Z"),snapshot_day:"2026-11-01",fetched_at:new Date("2026-11-01T12:00:00Z"),scalar:"0",response_state:"available" as const,boundary_basis:"provider_end_time",transport:"facebook",api_version:"v26.0",definition_version:"test-range",coverage_basis:"provider_end_time"};
  await db.insert(s.insightObservations).values([
    {...base,grain:"range",query_key:"a".repeat(64)},
    {...base,grain:"range",query_key:"b".repeat(64),fetched_at:new Date("2026-11-01T11:59:59Z")},
    {...base,grain:"audience_window",query_key:"c".repeat(64),snapshot_day:"2026-08-10"},
  ]);
  expect(await repo.pruneInsights(ws,new Date("2026-11-08T12:00:00+00:00"),1)).toBe(1);
  const retained=await db.select().from(s.insightObservations).where(and(eq(s.insightObservations.workspace_id,ws),eq(s.insightObservations.definition_version,"test-range")));
  expect(retained.map(o=>o.query_key)).toContain("a".repeat(64));
  expect(retained.map(o=>o.query_key)).not.toContain("b".repeat(64));
  expect(await repo.pruneInsights(ws,new Date("2026-11-08T07:00:00-05:00"),1)).toBe(0);
});
it("serves a second platform through the same storage and report functions",async()=>{
  const catalog=await import("./catalog");
  const metric: import("./types").InsightMetric={key:"views",label:"Views",level:"account",unit:"count",period:"day",grain:"day",aggregation:"sum",additive:true,definitionVersion:"test-views-v1",coverageBasis:"provider_end_time",cardOrder:1,chartable:true};
  const connector: import("./types").InsightsConnector={source:"test_youtube",catalog:()=>[metric],fetch:vi.fn(),access:vi.fn(),consentTransport:vi.fn()};
  const original=catalog.getInsightsConnector;
  const spy=vi.spyOn(catalog,"getInsightsConnector").mockImplementation(platform=>platform==="youtube" ? connector : original(platform));
  const yt=randomUUID(), ytRef={workspaceId:ws,channelId:yt};
  try {
    await db.insert(s.channels).values({id:yt,workspace_id:ws,platform:"youtube",platform_id:"test-account",webhook_secret:"test",token_encrypted:"test-placeholder"});
    await service.setCollectionMode(ytRef,"on");
    await db.update(s.insightConnections).set({transport:"test",credential_revision:"test-revision"}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,yt)));
    const observation: import("./types").InsightObservation={platform:"youtube",metricKey:"views",level:"account",subjectKey:"test-account",grain:"day",period:"day",metricType:"time_series",windowStart:"2026-11-01T00:00:00Z",windowEnd:"2026-11-02T00:00:00Z",snapshotDay:"2026-11-01",providerDay:"2026-11-01",boundaryBasis:"provider_end_time",fetchedAt:"2026-11-05T00:00:00Z",value:"0",state:"available",dimensions:{},queryParams:{},transport:"test",apiVersion:"test-v1",definitionVersion:metric.definitionVersion,coverageBasis:metric.coverageBasis};
    expect(await service.storeInsightBatch(ytRef,"test-revision",{observations:[observation],usage:{percent:null,regainAfterSeconds:null}})).toBe(1);
    const report=await service.readAccountInsights(ytRef,{level:"account",subjectKey:"test-account",grain:"day",metrics:["views"],from:observation.windowStart,to:observation.windowEnd});
    expect(report.status.source).toBe("test_youtube"); expect(report.summary[0]).toMatchObject({value:"0",complete:true});
    expect(connector.fetch).not.toHaveBeenCalled(); expect(connector.access).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); await db.delete(s.channels).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,yt))); }
});
it("finishes source removal while an observation write waits for that source",async()=>{
  const sourceId=randomUUID();
  const {encryptTokens}=await import("@/lib/crypto");
  const {insightCredentialRevision}=await import("./credentials");
  const sourceRevision=insightCredentialRevision("facebook","test-source-token");
  await db.insert(s.accountSources).values({id:sourceId,workspace_id:ws,provider:"meta",provider_account_id:"test-source",kind:"user",token_encrypted:encryptTokens({access_token:"test-source-token"})});
  await db.update(s.channels).set({source_id:sourceId}).where(and(eq(s.channels.workspace_id,ws),eq(s.channels.id,channelId)));
  await db.update(s.insightConnections).set({collection_mode:"on",transport:"facebook",credential_revision:sourceRevision,access_state:"unknown"}).where(and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId)));
  let pending:Promise<number> | undefined;
  await db.transaction(async tx=>{
    await tx.select().from(s.accountSources).where(and(eq(s.accountSources.workspace_id,ws),eq(s.accountSources.id,sourceId))).for("update");
    pending=service.storeInsightBatch(ref,sourceRevision,{observations:[],usage:{percent:null,regainAfterSeconds:null}});
    await vi.waitFor(async()=>{
      const result=await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"account_sources"%' AND pid<>pg_backend_pid()`);
      expect(result.rows.length).toBeGreaterThan(0);
    },{timeout:5000,interval:20});
    await tx.delete(s.accountSources).where(and(eq(s.accountSources.workspace_id,ws),eq(s.accountSources.id,sourceId)));
  });
  expect(await pending).toBe(0);
  expect((await service.getInsightStatus(ref)).state).toBe("unknown");
});
it("accepts only the current worker claim after collection is enabled again",async()=>{
  const {insightCredentialRevision}=await import("./credentials");
  const selectedRevision=insightCredentialRevision("facebook","new-user-token");
  const oldClaim=randomUUID(), currentClaim=randomUUID();
  const connectionWhere=and(eq(s.insightConnections.workspace_id,ws),eq(s.insightConnections.channel_id,channelId));
  await db.update(s.insightConnections).set({credential_revision:selectedRevision,claim_token:oldClaim,claim_until:new Date(Date.now()+60000)}).where(connectionWhere);
  await service.setCollectionMode(ref,"off"); await service.setCollectionMode(ref,"on");
  await db.update(s.insightConnections).set({transport:"facebook",credential_revision:selectedRevision,claim_token:currentClaim,claim_until:new Date(Date.now()+60000)}).where(connectionWhere);
  const {instagramCatalog}=await import("./instagram/catalog");
  const observation: import("./types").InsightObservation={platform:"instagram",metricKey:"reach",level:"account",subjectKey:"account",grain:"day",period:"day",metricType:"time_series",windowStart:"2026-11-01T08:00:00Z",windowEnd:"2026-11-02T08:00:00Z",snapshotDay:"2026-11-01",providerDay:"2026-11-01",boundaryBasis:"provider_end_time",fetchedAt:new Date().toISOString(),value:"12",state:"available",dimensions:{},queryParams:{},transport:"facebook",apiVersion:"v26.0",definitionVersion:instagramCatalog[0].definitionVersion,coverageBasis:"provider_end_time"};
  const batch={observations:[observation],usage:{percent:null,regainAfterSeconds:null}};
  const store=service.storeInsightBatch;
  expect(await store(ref,selectedRevision,batch,oldClaim)).toBe(0);
  expect(await store(ref,selectedRevision,batch)).toBe(0);
  expect((await service.getInsightStatus(ref)).state).toBe("unknown");
  await db.update(s.insightConnections).set({claim_until:new Date(Date.now()-1000)}).where(connectionWhere);
  expect(await store(ref,selectedRevision,batch,currentClaim)).toBe(0);
  await db.update(s.insightConnections).set({claim_until:new Date(Date.now()+60000)}).where(connectionWhere);
  expect(await store(ref,selectedRevision,batch,currentClaim)).toBe(1);
  expect((await service.getInsightStatus(ref)).state).toBe("ready");
});
