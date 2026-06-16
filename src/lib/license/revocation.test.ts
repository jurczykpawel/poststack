import { describe, it, expect, beforeEach } from "vitest";
import { getRevocations, orderHash, REVOCATION_PREFIX_LENGTH, __resetRevocationCache } from "@/lib/license/revocation";

const URL = "https://sellf.test/api/licenses/revoked?seller=s1";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const res = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

beforeEach(() => __resetRevocationCache());

describe("orderHash", () => {
  it("is a stable lowercase hex SHA-256", () => {
    const h = orderHash("cs_test_123");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toBe(orderHash("cs_test_123"));
    expect(h).not.toBe(orderHash("cs_test_124"));
  });

  // CROSS-REPO CONTRACT (golden vector). The seller (Sellf) publishes revoked orders as
  //   encode(digest(convert_to(order_id, 'UTF8'), 'sha256'), 'hex')   -- lowercase hex SHA-256.
  // This consumer must hash the token's `order` claim byte-identically, or a revoked license
  // silently stops matching the CRL (fail-open) and keeps working. Do NOT change this expected
  // value without changing Sellf's `seller_revoked_orders` SQL in lockstep — a drift on either
  // side turns this red on the side that drifted.
  it("matches the seller's published hash (golden vector — keep in sync with Sellf SQL)", () => {
    expect(orderHash("cs_test_123")).toBe(
      "9ee7e06645426cb1d3597dc641a1410e77e88a1d423b4e802948e427189f2df1",
    );
  });
});

describe("getRevocations", () => {
  it("appends the prefix to the seller URL and returns the bucket hashes", async () => {
    let seen = "";
    const r = await getRevocations({
      url: URL,
      prefix: "abcd",
      fetchImpl: async (u) => { seen = u; return res({ order_hashes: [H1, H2] }); },
    });
    expect(seen).toBe(`${URL}&prefix=abcd`);
    expect(r.fresh).toBe(true);
    expect([...r.hashes].sort()).toEqual([H1, H2].sort());
  });

  it("treats an empty bucket as a valid (no-revocations) response, not an error", async () => {
    const r = await getRevocations({ url: URL, prefix: "abcd", fetchImpl: async () => res({ order_hashes: [] }) });
    expect(r.fresh).toBe(true);
    expect(r.hashes.size).toBe(0);
  });

  it("caches per prefix (different prefixes don't share a bucket)", async () => {
    let calls = 0;
    const f = async () => { calls++; return res({ order_hashes: [H1] }); };
    await getRevocations({ url: URL, prefix: "aaaa", fetchImpl: f, now: 1000 });
    await getRevocations({ url: URL, prefix: "aaaa", fetchImpl: f, now: 1000 + 60_000 }); // fresh cache hit
    await getRevocations({ url: URL, prefix: "bbbb", fetchImpl: f, now: 1000 }); // different bucket → refetch
    expect(calls).toBe(2);
  });

  it("serves the stale cache on a failed refresh (keeps known revocations during an outage)", async () => {
    await getRevocations({ url: URL, prefix: "abcd", fetchImpl: async () => res({ order_hashes: [H1] }), now: 1000 });
    const out = await getRevocations({ url: URL, prefix: "abcd", fetchImpl: async () => { throw new Error("down"); }, now: 1000 + 10 * 60_000 });
    expect(out.hashes.has(H1)).toBe(true);
  });

  it("fails OPEN with an empty set when there is no cache and the fetch fails", async () => {
    const out = await getRevocations({ url: URL, prefix: "abcd", fetchImpl: async () => { throw new Error("down"); } });
    expect(out.hashes.size).toBe(0);
  });

  it("fails OPEN on a non-200 response with no cache", async () => {
    const out = await getRevocations({ url: URL, prefix: "abcd", fetchImpl: async () => res({}, false) });
    expect(out.hashes.size).toBe(0);
  });

  it("prefix length matches the server contract (2..16 hex)", () => {
    expect(REVOCATION_PREFIX_LENGTH).toBeGreaterThanOrEqual(2);
    expect(REVOCATION_PREFIX_LENGTH).toBeLessThanOrEqual(16);
  });
});
