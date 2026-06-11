import { describe, it, expect, beforeEach } from "vitest";
import { getJwks, parseJwksJson, __resetJwksCache, type JwksResult } from "@/lib/license/jwks";
import type { JwksKey } from "@/lib/license/format";

const URL = "https://sellf.example/api/licenses/jwks?seller=tsa";
const KEYS: JwksKey[] = [{ kid: "k1", alg: "ES256", pem: "PEM-1" }];
const FALLBACK: JwksKey[] = [{ kid: "fb", alg: "ES256", pem: "PEM-FB" }];

function okFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}
function failFetch(): (url: string) => Promise<Response> {
  return async () => {
    throw new Error("network down");
  };
}

beforeEach(() => __resetJwksCache());

describe("getJwks", () => {
  it("fetches and caches; a second call within the fresh window does not refetch", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ keys: KEYS }), { status: 200 });
    };
    const a = await getJwks({ url: URL, fetchImpl, now: 0 });
    const b = await getJwks({ url: URL, fetchImpl, now: 1000 });
    expect(a.keys).toEqual(KEYS);
    expect(b.keys).toEqual(KEYS);
    expect(calls).toBe(1);
  });

  it("refetches once the fresh window elapses", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ keys: KEYS }), { status: 200 });
    };
    await getJwks({ url: URL, fetchImpl, now: 0 });
    await getJwks({ url: URL, fetchImpl, now: 6 * 60_000 });
    expect(calls).toBe(2);
  });

  it("serves stale keys when a later refresh fails (outage must not revoke)", async () => {
    await getJwks({ url: URL, fetchImpl: okFetch(KEYS), now: 0 });
    const res = await getJwks({ url: URL, fetchImpl: failFetch(), now: 10 * 60_000 });
    expect(res.keys).toEqual(KEYS);
  });

  it("uses pinned fallback when nothing is cached and the fetch fails", async () => {
    const res = await getJwks({ url: URL, fetchImpl: failFetch(), fallbackKeys: FALLBACK, now: 0 });
    expect(res.keys).toEqual(FALLBACK);
  });

  it("fails closed when there is no cache and no fallback", async () => {
    await expect(getJwks({ url: URL, fetchImpl: failFetch(), now: 0 })).rejects.toThrow();
  });

  it("treats an empty key set as a soft failure (cannot overwrite good keys)", async () => {
    await getJwks({ url: URL, fetchImpl: okFetch(KEYS), now: 0 });
    const res = await getJwks({ url: URL, fetchImpl: okFetch([]), now: 10 * 60_000 });
    expect(res.keys).toEqual(KEYS);
  });

  it("invokes onFreshKeys only when keys are newly fetched from the network", async () => {
    const seen: JwksKey[][] = [];
    const onFreshKeys = (k: JwksKey[]) => seen.push(k);
    await getJwks({ url: URL, fetchImpl: okFetch(KEYS), now: 0, onFreshKeys }); // fresh
    await getJwks({ url: URL, fetchImpl: okFetch(KEYS), now: 1000, onFreshKeys }); // cache hit
    expect(seen).toEqual([KEYS]);
  });

  it("reports fresh vs cached in the result", async () => {
    const first: JwksResult = await getJwks({ url: URL, fetchImpl: okFetch(KEYS), now: 0 });
    const second: JwksResult = await getJwks({ url: URL, fetchImpl: okFetch(KEYS), now: 1000 });
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);
  });
});

describe("parseJwksJson", () => {
  it("parses a valid snapshot", () => {
    expect(parseJwksJson(JSON.stringify({ keys: KEYS }))).toEqual(KEYS);
  });
  it("returns [] for null/garbage", () => {
    expect(parseJwksJson(null)).toEqual([]);
    expect(parseJwksJson("not json")).toEqual([]);
    expect(parseJwksJson(JSON.stringify({ nope: 1 }))).toEqual([]);
  });
  it("drops entries missing kid or pem", () => {
    const raw = JSON.stringify({ keys: [{ kid: "k1", alg: "ES256", pem: "P" }, { kid: "k2" }] });
    expect(parseJwksJson(raw)).toEqual([{ kid: "k1", alg: "ES256", pem: "P" }]);
  });
});
