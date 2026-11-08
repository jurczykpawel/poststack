import { expect, it, vi } from "vitest";
vi.mock("@/lib/db",()=>({db:{}}));
vi.mock("@/lib/license/gate",()=>({requireFeature:vi.fn()}));
vi.mock("./catalog",()=>({getInsightsConnector:vi.fn()}));
vi.mock("./credentials",()=>({resolveInsightCredential:vi.fn()}));
import { dailyDue, retryDue, usageDue, collectionQueries, insightLane } from "./schedule";
it("corrects recent provider windows before bounded history", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const queries = collectionQueries(now, "account", ["reach"], {version:1});
  expect(queries.slice(0,4).map(q=>q.from.slice(0,10))).toEqual(["2026-11-07","2026-11-06","2026-11-05","2026-11-01"]);
  expect(queries.length).toBeLessThanOrEqual(10);
  expect(queries.every(q=>Date.parse(q.from)>=Date.parse("2026-08-10T00:00:00Z"))).toBe(true);
  expect(collectionQueries(now,"account",["reach"],{version:1,cursor:"2026-10-01T00:00:00.000Z"})[4].to).toBe("2026-10-01T00:00:00.000Z");
});
it("keeps retry floors, daily jitter and usage deferrals", () => {
  const now=new Date("2026-11-08T12:00:00Z");
  expect(dailyDue(now,()=>1).getTime()-now.getTime()).toBe(25*3600000);
  expect(retryDue(now,1,0,()=>0).getTime()-now.getTime()).toBe(60000);
  expect(retryDue(now,1,172800,()=>0).getTime()-now.getTime()).toBe(172800000);
  expect(usageDue(now,80,null)?.getTime()).toBe(now.getTime()+900000);
  expect(usageDue(now,90,null)?.getTime()).toBe(now.getTime()+3600000);
  expect(usageDue(now,20,120)?.getTime()).toBe(now.getTime()+120000);
  expect(insightLane("ws","shared")).toBe(insightLane("ws","shared"));
});
