import { describe, it, expect, beforeAll } from "vitest";

// Pure-function unit tests for the area gate. Importing gate.ts pulls env (validated) + db (lazy
// pool, no connection until a query), so set a minimal env; the functions under test never query.
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
});

describe("entitledFeatures (tier ∧ area)", () => {
  it("an all-access tier+products unlocks both wings + core", async () => {
    const { entitledFeatures } = await import("./gate");
    const f = entitledFeatures("pro", new Set(["core", "publishing", "replies"]));
    expect(f.has("sequences")).toBe(true); // replies
    expect(f.has("multi_brand")).toBe(true); // publishing
    expect(f.has("managed_connection")).toBe(true); // core
  });

  it("a publishing-only entitlement excludes replies features", async () => {
    const { entitledFeatures } = await import("./gate");
    const f = entitledFeatures("pro", new Set(["core", "publishing"]));
    expect(f.has("multi_brand")).toBe(true);
    expect(f.has("sequences")).toBe(false);
    expect(f.has("managed_connection")).toBe(true); // core always entitled
  });

  it("ANTI-BYPASS invariant: with no entitled products, even the highest tier unlocks only core", async () => {
    // The grant comes from the signed token's products, not the registry. With empty products, a
    // business-tier instance gets NO publishing/replies feature — so lowering a feature's minTier in
    // the registry alone can never unlock a wing whose area the token doesn't grant.
    const { entitledFeatures } = await import("./gate");
    const f = entitledFeatures("business", new Set());
    expect(f.has("sequences")).toBe(false); // replies — area-gated regardless of tier
    expect(f.has("multi_brand")).toBe(false); // publishing — area-gated regardless of tier
    expect(f.has("managed_connection")).toBe(true); // core — always entitled
    // every entitled feature must be a core feature
    const { featureArea } = await import("./features");
    for (const key of f) expect(featureArea(key)).toBe("core");
  });

  it("no tier (free instance) grants nothing even with all products", async () => {
    const { entitledFeatures } = await import("./gate");
    expect(entitledFeatures(null, new Set(["core", "publishing", "replies"])).size).toBe(0);
  });
});

describe("deriveProducts (token-derived areas)", () => {
  it("an explicit products claim is authoritative and always includes core", async () => {
    const { deriveProducts } = await import("./gate");
    expect(deriveProducts({ product: "poststack", products: ["publishing"] } as never)).toEqual(
      new Set(["core", "publishing"]),
    );
  });

  it("falls back to the product slug when no products claim", async () => {
    const { deriveProducts } = await import("./gate");
    expect(deriveProducts({ product: "poststack-replies" } as never)).toEqual(new Set(["core", "replies"]));
    expect(deriveProducts({ product: "poststack" } as never)).toEqual(
      new Set(["core", "publishing", "replies"]),
    );
  });

  it("an unknown product slug with no products claim defaults to all-access (never lock out)", async () => {
    const { deriveProducts } = await import("./gate");
    expect(deriveProducts({ product: "acme-custom" } as never)).toEqual(
      new Set(["core", "publishing", "replies"]),
    );
  });
});
