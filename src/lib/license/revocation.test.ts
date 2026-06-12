import { describe, it, expect, beforeEach } from "vitest";
import { getRevocations, __resetRevocationCache } from "@/lib/license/revocation";

const URL = "https://sellf.test/api/licenses/revoked?seller=s1";
const res = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

beforeEach(() => __resetRevocationCache());

describe("getRevocations", () => {
  it("fetches the revoked order list", async () => {
    const r = await getRevocations({ url: URL, fetchImpl: async () => res({ orders: ["o1", "o2"] }) });
    expect(r.fresh).toBe(true);
    expect([...r.orders].sort()).toEqual(["o1", "o2"]);
  });

  it("treats an empty list as a valid (no-revocations) response, not an error", async () => {
    const r = await getRevocations({ url: URL, fetchImpl: async () => res({ orders: [] }) });
    expect(r.fresh).toBe(true);
    expect(r.orders.size).toBe(0);
  });

  it("serves the fresh cache without refetching", async () => {
    let calls = 0;
    const f = async () => { calls++; return res({ orders: ["o1"] }); };
    await getRevocations({ url: URL, fetchImpl: f, now: 1000 });
    const second = await getRevocations({ url: URL, fetchImpl: f, now: 1000 + 60_000 });
    expect(calls).toBe(1);
    expect(second.orders.has("o1")).toBe(true);
  });

  it("serves the stale cache on a failed refresh (keeps known revocations during an outage)", async () => {
    await getRevocations({ url: URL, fetchImpl: async () => res({ orders: ["o1"] }), now: 1000 });
    const out = await getRevocations({ url: URL, fetchImpl: async () => { throw new Error("down"); }, now: 1000 + 10 * 60_000 });
    expect(out.orders.has("o1")).toBe(true); // still revoked from stale cache
  });

  it("fails OPEN with an empty set when there is no cache and the fetch fails", async () => {
    const out = await getRevocations({ url: URL, fetchImpl: async () => { throw new Error("down"); } });
    expect(out.orders.size).toBe(0); // unknown => not revoked, never lock out a paying customer on a network blip
  });

  it("fails OPEN on a non-200 response with no cache", async () => {
    const out = await getRevocations({ url: URL, fetchImpl: async () => res({}, false) });
    expect(out.orders.size).toBe(0);
  });
});
