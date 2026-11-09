import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightMetric, InsightObservation, InsightQuery } from "./types";
import { instagramCatalog } from "./instagram/catalog";
import { entitledFeatures, ProRequiredError } from "@/lib/license/gate";
vi.hoisted(() => { Object.assign(process.env, {DATABASE_URL:"postgres://test:test@localhost:55684/test",ENCRYPTION_KEY:"test-encryption-key-at-least-32-characters",JWT_SECRET:"test-secret-at-least-32-characters",CRON_SECRET:"test-cron-at-least-32-characters-long",APP_URL:"http://localhost:3472"}); });
vi.mock("@/lib/license/gate", async (original) => ({ ...await original<typeof import("@/lib/license/gate")>(), requireFeature: vi.fn() }));
vi.mock("./repository", () => ({ findInsightChannel: vi.fn(), loadInsightContext: vi.fn(), readObservations: vi.fn(), changeCollectionMode: vi.fn(), upsertInsightBatch: vi.fn() }));
vi.mock("./catalog", () => ({ getInsightsConnector: vi.fn() }));
import { requireFeature } from "@/lib/license/gate";
import * as repository from "./repository";
import { getInsightsConnector } from "./catalog";
import { buildAccountReport, getInsightStatus, readAccountInsights, readAccountReport, storeInsightBatch } from "./service";
const metric: InsightMetric = { ...instagramCatalog[0], key: "views", aggregation: "sum", additive: true, definitionVersion: "views-v1", coverageBasis: "provider_end_time" };
const query: InsightQuery = { level: "account", subjectKey: "account", from: "2026-10-03T08:00:00Z", to: "2026-10-05T08:00:00Z", metrics: ["views"], grain: "day" };
function point(day: number, value: string | null, overrides: Partial<InsightObservation> = {}): InsightObservation {
  return { platform: "instagram", metricKey: "views", level: "account", subjectKey: "account", grain: "day", period: "day", metricType: "time_series", windowStart: `2026-10-0${day}T08:00:00Z`, windowEnd: `2026-10-0${day+1}T08:00:00Z`, snapshotDay: `2026-10-0${day}`, fetchedAt: "2026-10-08T00:00:00Z", providerDay: `2026-10-0${day}`, boundaryBasis: "provider_end_time", value, state: value === null ? "not_available" : "available", dimensions: {}, queryParams: {}, transport: "facebook", apiVersion: "v26.0", definitionVersion: metric.definitionVersion, coverageBasis: metric.coverageBasis, ...overrides };
}
const reachPoint = { metricKey: "reach", definitionVersion: instagramCatalog[0].definitionVersion, coverageBasis: instagramCatalog[0].coverageBasis };
const status = { channelId: "channel", platform: "instagram" as const, source: "meta_instagram", collectionMode: "on" as const, displayStatus: "connected" as const, state: "ready" as const, transport: "facebook", credentialRevision: "rev", requiredPermissions: [], missingPermissions: [], checkedAt: null, lastAttemptAt: null, lastSuccessfulSyncAt: null, nextRetryAt: null, reason: "none" as const, stale: false };
describe("account report", () => {
  it("sums complete disjoint days and preserves decimal precision", () => {
    const report = buildAccountReport([metric], [point(3,"9007199254740993.1"),point(4,"20.2"),point(1,"0"),point(2,"0")],query,status);
    expect(report.summary[0]).toMatchObject({ value: "9007199254741013.3", complete: true, comparisonPercent: null });
  });
  it("never adds daily unique reach or invents an inactive metric's zero", () => {
    const report = buildAccountReport(instagramCatalog, [point(3,"10",{metricKey:"reach"}),point(4,"20",{metricKey:"reach"})],{...query,metrics:["reach"]},status);
    expect(report.summary.find(m=>m.metricKey==="reach")?.value).toBeNull();
    expect(report.summary.find(m=>m.metricKey==="views")).toMatchObject({value:null,complete:false,reason:"no_account_response_evidence"});
  });
  it("requires exact unique range and keeps mismatched cache unavailable", () => {
    const range = point(3,"12",{metricKey:"reach",grain:"range",metricType:"total_value",windowEnd:query.to,definitionVersion:instagramCatalog[0].definitionVersion});
    expect(buildAccountReport(instagramCatalog,[range],{...query,metrics:["reach"]},status).summary[0].value).toBe("12");
    expect(buildAccountReport(instagramCatalog,[{...range,windowEnd:"2026-10-04T08:00:00Z"}],{...query,metrics:["reach"]},status).summary[0].value).toBeNull();
  });
  it("does not combine definitions, transports, coverage or overlapping intervals", () => {
    for (const change of [{transport:"instagram_business"},{coverageBasis:"first_start_unconfirmed"},{definitionVersion:"old"},{windowStart:query.from}]) {
      expect(buildAccountReport([metric],[point(3,"10"),point(4,"20",change)],query,status).summary[0]).toMatchObject({complete:false,comparisonPercent:null});
    }
  });
  it("uses latest correction, missing points leave gaps, comparison requires equal complete windows", () => {
    const points = [point(1,"10"),point(2,"10"),point(3,"10"),point(4,"20"),point(3,"20",{fetchedAt:"2026-10-09T00:00:00Z"})];
    expect(buildAccountReport([metric],points,query,status).summary[0]).toMatchObject({value:"40",complete:true,comparisonPercent:"100"});
    expect(buildAccountReport([metric],points.filter(p=>p.snapshotDay!=="2026-10-02"),query,status).summary[0].comparisonPercent).toBeNull();
    expect(buildAccountReport([metric],[point(3,"0"),point(4,null)],query,status).summary[0]).toMatchObject({value:null,complete:false});
  });
  it("keeps first-of-batch days in the series as partial and never sums them", () => {
    const estimated = { boundaryBasis: "provider_end_time_first_start_unconfirmed" };
    const reach = buildAccountReport(instagramCatalog,[point(3,"10",{...reachPoint,...estimated}),point(4,"20",reachPoint)],{...query,metrics:["reach"]},status);
    expect(reach.series.map(o=>[o.providerDay,o.value,o.partial])).toEqual([["2026-10-03","10",true],["2026-10-04","20",false]]);
    const views = buildAccountReport([metric],[point(3,"10",estimated),point(4,"20")],query,status);
    expect(views.series).toHaveLength(2);
    expect(views.summary[0]).toMatchObject({value:null,complete:false});
  });
  it("merges one provider interval stored as a first and a follow-on point, keeping the confirmed start", () => {
    // Same provider end_time; the estimated start is one hour off on an offset-change day.
    const confirmed = point(3,"10",{...reachPoint,windowStart:"2026-10-03T07:00:00Z"});
    const estimated = point(3,"11",{...reachPoint,fetchedAt:"2026-10-09T00:00:00Z",boundaryBasis:"provider_end_time_first_start_unconfirmed"});
    const report = buildAccountReport(instagramCatalog,[confirmed,estimated],{...query,from:"2026-10-03T07:00:00Z",metrics:["reach"]},status);
    expect(report.series).toHaveLength(1);
    expect(report.series[0]).toMatchObject({value:"11",windowStart:"2026-10-03T07:00:00Z",providerDay:"2026-10-03",boundaryBasis:"provider_end_time",partial:false});
  });
  it("keeps provider offsets and marks recent observations provisional", () => {
    const report=buildAccountReport([metric],[point(3,"0",{fetchedAt:new Date().toISOString()})],query,status);
    expect(report.series[0].windowStart).toBe("2026-10-03T08:00:00Z");
    expect(typeof report.series[0].provisional).toBe("boolean");
  });
});
describe("service boundary",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("gates before reading or fetching",async()=>{
    vi.mocked(requireFeature).mockRejectedValueOnce(new ProRequiredError("insights"));
    await expect(readAccountInsights({workspaceId:"ws",channelId:"ch"},query)).rejects.toBeInstanceOf(ProRequiredError);
    expect(repository.loadInsightContext).not.toHaveBeenCalled();
  });
  it("uses the connector catalog for another platform without a provider request",async()=>{
    vi.mocked(repository.loadInsightContext).mockResolvedValue({channel:{platform:"youtube",platform_id:"account",status:"active"},connection:null} as Awaited<ReturnType<typeof repository.loadInsightContext>>);
    const fetch=vi.fn();
    vi.mocked(getInsightsConnector).mockReturnValue({source:"test_youtube",catalog:()=>[metric],fetch,access:vi.fn(),consentTransport:vi.fn()});
    vi.mocked(repository.readObservations).mockResolvedValue([point(3,"10"),point(4,"20")]);
    const report=await readAccountInsights({workspaceId:"ws",channelId:"ch"},query);
    expect(report.status.source).toBe("test_youtube"); expect(report.summary[0].value).toBe("30"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([["off","ready","off"],["on","unknown","checking"],["on","missing_permission","additional_access_required"],["on","needs_reauth","additional_access_required"],["on","unsupported","additional_access_required"],["on","ready","connected"]] as const)("maps %s/%s",async(mode,state,display)=>{
    vi.mocked(repository.loadInsightContext).mockResolvedValue({channel:{platform:"instagram",platform_id:"account",status:"active"},connection:{collection_mode:mode,access_state:state,reason:"none"}} as Awaited<ReturnType<typeof repository.loadInsightContext>>);
    expect((await getInsightStatus({workspaceId:"ws",channelId:"ch"})).displayStatus).toBe(display);
  });
  it("requires publishing PRO entitlement",()=>{
    expect(entitledFeatures(null,new Set(["publishing"])).has("insights")).toBe(false);
    expect(entitledFeatures("pro",new Set(["replies"])).has("insights")).toBe(false);
    expect(entitledFeatures("pro",new Set(["publishing"])).has("insights")).toBe(true);
  });
});
it("covers adjacent provider days through a 23-hour DST day without changing their dates",()=>{
  const dstQuery={...query,from:"2026-03-28T08:00:00+01:00",to:"2026-03-30T08:00:00+02:00"};
  const report=buildAccountReport([metric],[
    point(3,"10",{windowStart:dstQuery.from,windowEnd:"2026-03-29T08:00:00+02:00",providerDay:"2026-03-28"}),
    point(4,"20",{windowStart:"2026-03-29T08:00:00+02:00",windowEnd:dstQuery.to,providerDay:"2026-03-29"}),
  ],dstQuery,status);
  expect(report.summary[0]).toMatchObject({value:"30",complete:true});
  expect(report.series.map(p=>p.providerDay)).toEqual(["2026-03-28","2026-03-29"]);
});
it("keeps zero as a point and computes a negative comparison without numeric conversion",()=>{
  const report=buildAccountReport([metric],[point(1,"10"),point(2,"20"),point(3,"0"),point(4,"10")],query,status);
  expect(report.summary[0]).toMatchObject({value:"10",comparisonPercent:"-66.666667"});
  expect(report.series[0].value).toBe("0");
});
it("keeps daily series alongside an exact unique-range cache",()=>{
  const reach=instagramCatalog[0];
  const report=buildAccountReport([reach],[
    point(3,"10",{metricKey:"reach",definitionVersion:reach.definitionVersion}),
    point(4,"20",{metricKey:"reach",definitionVersion:reach.definitionVersion}),
    point(3,"23",{metricKey:"reach",definitionVersion:reach.definitionVersion,grain:"range",metricType:"total_value",windowEnd:query.to,fetchedAt:"2026-10-09T00:00:00Z"}),
  ],{...query,metrics:["reach"]},status);
  expect(report.summary[0].value).toBe("23"); expect(report.series.map(p=>p.value)).toEqual(["10","20"]);
});

it("rejects available day observations with inconsistent provider dates or windows",async()=>{
  vi.mocked(requireFeature).mockResolvedValue(undefined);
  vi.mocked(repository.loadInsightContext).mockResolvedValue({channel:{platform:"instagram",platform_id:"account",status:"active"},connection:null});
  vi.mocked(getInsightsConnector).mockReturnValue({catalog:()=>instagramCatalog,fetch:vi.fn(),access:vi.fn(),consentTransport:vi.fn()});
  vi.mocked(repository.upsertInsightBatch).mockResolvedValue(0);
  const reach=instagramCatalog[0];
  for (const change of [{providerDay:null},{providerDay:"2026-10-02"},{windowEnd:"2026-10-06T08:00:00Z"},{windowStart:"2026-02-30T08:00:00Z",windowEnd:"2026-03-03T08:00:00Z"}]) {
    const o=point(3,"12",{metricKey:"reach",definitionVersion:reach.definitionVersion,...change});
    await expect(storeInsightBatch({workspaceId:"ws",channelId:"ch"},"rev",{observations:[o],usage:{percent:null,regainAfterSeconds:null}})).rejects.toThrow("Invalid insights observation");
  }
});

it("maps provider calendar days to the connector's day boundaries, including 90 days across a clock change",async()=>{
  vi.mocked(requireFeature).mockResolvedValue(undefined);
  vi.mocked(repository.findInsightChannel).mockResolvedValue({platform:"instagram",platform_id:"account"});
  vi.mocked(repository.loadInsightContext).mockResolvedValue({channel:{platform:"instagram",platform_id:"account",status:"active"},connection:null});
  vi.mocked(repository.readObservations).mockResolvedValue([]);
  vi.mocked(getInsightsConnector).mockReturnValue({dayTimeZone:"America/Los_Angeles",catalog:()=>instagramCatalog,fetch:vi.fn(),access:vi.fn(),consentTransport:vi.fn()});
  const ref={workspaceId:"ws",channelId:"ch"};
  await readAccountReport(ref,{from:"2018-01-10",to:"2018-01-12"});
  expect(vi.mocked(repository.readObservations).mock.lastCall?.[1]).toMatchObject({from:"2018-01-10T08:00:00.000Z",to:"2018-01-12T08:00:00.000Z",metrics:["reach"],grain:"day"});
  await readAccountReport(ref,{from:"2026-09-01",to:"2026-11-30"});
  expect(vi.mocked(repository.readObservations).mock.lastCall?.[1]).toMatchObject({from:"2026-09-01T07:00:00.000Z",to:"2026-11-30T08:00:00.000Z"});
  vi.mocked(getInsightsConnector).mockReturnValue({catalog:()=>instagramCatalog,fetch:vi.fn(),access:vi.fn(),consentTransport:vi.fn()});
  await readAccountReport(ref,{from:"2026-10-03",to:"2026-10-04"});
  expect(vi.mocked(repository.readObservations).mock.lastCall?.[1]).toMatchObject({from:"2026-10-03T00:00:00.000Z",to:"2026-10-04T00:00:00.000Z"});
});
