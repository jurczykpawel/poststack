import { describe, it, expect, vi, beforeEach } from "vitest";

// BRANDLIMIT1: the lock logic is pure given (tier limit, ordered brand list). Stub the DB query and
// the license tier so we test the ordering+slicing rule without infra.
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { query: { brands: { findMany: (...a: unknown[]) => findMany(...a) } } } }));
// gate.ts loads @/lib/env at import (throws without a full .env); stub it — limitFor/currentTier don't read it.
vi.mock("@/lib/env", () => ({ env: {} }));

const currentTier = vi.fn();
vi.mock("@/lib/license/gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/license/gate")>("@/lib/license/gate");
  return { ...actual, currentTier: () => currentTier() };
});

import { lockedBrandKeys, isBrandLocked } from "./access";

const WS = "ws-1";

beforeEach(() => {
  findMany.mockReset();
  currentTier.mockReset();
});

describe("lockedBrandKeys (BRANDLIMIT1)", () => {
  it("free tier (limit 1) locks every brand beyond the oldest one", async () => {
    currentTier.mockResolvedValue(null); // null = free
    findMany.mockResolvedValue([{ key: "a" }, { key: "b" }, { key: "c" }]); // already created_at/key ordered
    const locked = await lockedBrandKeys(WS);
    expect([...locked].sort()).toEqual(["b", "c"]);
    expect(locked.has("a")).toBe(false);
  });

  it("free tier with a single brand locks nothing", async () => {
    currentTier.mockResolvedValue(null);
    findMany.mockResolvedValue([{ key: "only" }]);
    expect((await lockedBrandKeys(WS)).size).toBe(0);
  });

  it("an unlimited tier locks nothing and never hits the DB", async () => {
    currentTier.mockResolvedValue("pro");
    const locked = await lockedBrandKeys(WS);
    expect(locked.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("business tier also unlimited", async () => {
    currentTier.mockResolvedValue("business");
    expect((await lockedBrandKeys(WS)).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("isBrandLocked", () => {
  it("true for a brand beyond the free limit, false for the active one", async () => {
    currentTier.mockResolvedValue(null);
    findMany.mockResolvedValue([{ key: "keep" }, { key: "drop" }]);
    expect(await isBrandLocked(WS, "drop")).toBe(true);
    currentTier.mockResolvedValue(null);
    findMany.mockResolvedValue([{ key: "keep" }, { key: "drop" }]);
    expect(await isBrandLocked(WS, "keep")).toBe(false);
  });
});
