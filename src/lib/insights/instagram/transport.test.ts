import { afterEach, describe, expect, it, vi } from "vitest";
import series from "../__fixtures__/instagram/account-series.json";
import denied from "../__fixtures__/instagram/facebook-denied.json";
import igDenied from "../__fixtures__/instagram/instagram_business-denied.json";
import { instagramInsightsConnector, readUsage, classifyInsightError } from "./transport";
import type { InsightCredential, InsightQuery } from "../types";
const credential: InsightCredential = { transport: "facebook", token: "private-token", accountKey: "account", revision: "rev", budgetKey: "budget" };
const query: InsightQuery = { level: "account", subjectKey: "account", from: "2018-01-10T08:00:00Z", to: "2018-01-12T08:00:00Z", metrics: ["reach"], grain: "day" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Instagram insights requests", () => {
  it.each([["facebook", "graph.facebook.com"], ["instagram_business", "graph.instagram.com"]])("uses the fixed %s host and bearer", async (transport, host) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(series.responseText)); vi.stubGlobal("fetch", fetcher);
    const result = await instagramInsightsConnector.fetch({ ...credential, transport }, query);
    expect(result.observations[0].value).toBe("12");
    const [url, options] = fetcher.mock.calls[0];
    expect(new URL(url).hostname).toBe(host);
    expect(new URL(url).searchParams.get("metric_type")).toBe("time_series");
    expect(new URL(url).searchParams.get("until")).toBe(String(Date.parse(query.to) / 1000 + 86400 - 1));
    expect(String(url)).not.toContain(credential.token);
    expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: `Bearer ${credential.token}` } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("returns only Instagram's connector from the shared provider", async () => {
    const { metaProvider } = await import("@/lib/providers/meta");
    expect(metaProvider.insights?.("instagram")).toBe(instagramInsightsConnector);
    expect(metaProvider.insights?.("facebook")).toBeUndefined();
  });
  it.each([denied, igDenied])("classifies recorded permission denials", async (fixture) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture.response), { status: 400 })); vi.stubGlobal("fetch", fetcher);
    await expect(instagramInsightsConnector.fetch(credential, query)).rejects.toEqual({ kind: "missing_permission", retryAfterSeconds: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects inactive recipes and bounds queries before fetching", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const change of [{ metrics: ["views"] }, { grain: "snapshot" as const }, { from: "invalid" }, { subjectKey: "other" }]) {
      await expect(instagramInsightsConnector.fetch(credential, { ...query, ...change })).rejects.toBeDefined();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not follow provider paging or redirects, and bounds streamed bodies", async () => {
    // Paging mutation of the exact account example.
    const paged = JSON.parse(series.responseText); paged.paging = { next: "https://elsewhere.example/next" };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(paged))); vi.stubGlobal("fetch", fetcher);
    await instagramInsightsConnector.fetch(credential, query); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    await expect(instagramInsightsConnector.fetch(credential, query)).rejects.toEqual({ kind: "unknown", retryAfterSeconds: null });
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(256 * 1024)); c.enqueue(new Uint8Array(1)); c.close(); } })));
    await expect(instagramInsightsConnector.fetch(credential, query)).rejects.toEqual({ kind: "unknown", retryAfterSeconds: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("aborts a pending fetch at 15 seconds", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout")))));
    vi.stubGlobal("fetch", fetcher);
    const pending = expect(instagramInsightsConnector.fetch(credential, query)).rejects.toEqual({ kind: "transient", retryAfterSeconds: null });
    await vi.advanceTimersByTimeAsync(15000); await pending;
  });
  it("reports access only for the probed credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(series.responseText)));
    expect(await instagramInsightsConnector.access(credential)).toMatchObject({ state: "ready", credentialRevision: "rev", transport: "facebook" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":{"code":190}}', { status: 400 })));
    expect(await instagramInsightsConnector.access(credential)).toMatchObject({ state: "needs_reauth" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":{"code":10,"message":"Application does not have permission for this action"}}', { status: 403 })));
    expect(await instagramInsightsConnector.access(credential)).toMatchObject({ state: "missing_permission" });
  });
});
describe("Insights error and usage metadata", () => {
  it("uses bounded known codes and leaves ambiguous denials unknown", () => {
    expect(classifyInsightError(400, { code: "190" }, null).kind).toBe("invalid_token");
    expect(classifyInsightError(400, { code: "100" }, null).kind).toBe("unknown");
    expect(classifyInsightError(503, {}, null).kind).toBe("transient");
    expect(classifyInsightError(429, {}, "120")).toEqual({ kind: "rate_limited", retryAfterSeconds: 120 });
  });
  it("takes the maximum usage and converts regain minutes to seconds", () => {
    expect(readUsage(new Headers())).toEqual({ percent: null, regainAfterSeconds: null });
    expect(readUsage(new Headers({ "x-app-usage": '{"call_count":30,"total_time":85,"total_cputime":12}', "x-business-use-case-usage": '{"id":[{"call_count":90,"estimated_time_to_regain_access":2}]}' })))
      .toEqual({ percent: 90, regainAfterSeconds: 120 });
  });
});

it("retains transient access failures for the caller's existing state", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
  await expect(instagramInsightsConnector.access(credential)).rejects.toEqual({ kind: "transient", retryAfterSeconds: null });
});

it("also aborts a stalled body stream at 15 seconds", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
  const pending = expect(instagramInsightsConnector.fetch(credential, query)).rejects.toEqual({ kind: "transient", retryAfterSeconds: null });
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
  expect(cancel).toHaveBeenCalledTimes(1);
});
it.each([[80,900],[90,3600]])("retains usage %s deferral on recorded denied responses",async(percent,seconds)=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(denied.response),{status:400,headers:{"x-app-usage":JSON.stringify({call_count:percent})}})));
  await expect(instagramInsightsConnector.fetch(credential,query)).rejects.toMatchObject({retryAfterSeconds:seconds});
});
it("retains usage deferral when the body cannot be parsed",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("unavailable",{headers:{"x-app-usage":'{"call_count":90}'}})));
  await expect(instagramInsightsConnector.fetch(credential,query)).rejects.toMatchObject({retryAfterSeconds:3600});
});

it.each([
  [403, {code:10,type:"IGApiException",message:"Application does not have permission for this action"}, "missing_permission"],
  [403, {code:200,type:"OAuthException",message:"Permissions error"}, "missing_permission"],
  [400, {code:299,error_subcode:0}, "missing_permission"],
  [400, {code:"10"}, "missing_permission"],
  [400, {code:100,message:"(#100) The value must be a valid insights metric"}, "unsupported_metric"],
  [400, {code:100,message:"(#100) metric[0] must be one of the following values: reach"}, "unsupported_metric"],
  [400, {code:100,error_subcode:33,message:"Unsupported get request. Object does not exist or is missing permissions"}, "unknown"],
  [400, {code:100,message:"Invalid period parameter"}, "unknown"],
  [400, {code:100,message:"metric_type must be time_series"}, "unknown"],
  [400, {code:190,error_subcode:463}, "invalid_token"],
  [400, {code:4}, "rate_limited"],
  [503, {code:10,is_transient:true}, "transient"],
] as const)("classifies HTTP %s %j as %s", (status,error,kind)=>{
  expect(classifyInsightError(status,error,null)).toEqual({kind,retryAfterSeconds:null});
});
