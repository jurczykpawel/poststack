import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    outboundIdempotency: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

import { isClaimed, claim } from "./idempotency";

const NOW = new Date("2026-06-05T12:00:00.000Z");

describe("idempotency.isClaimed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is false when no row exists", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    expect(await isClaimed("k", NOW)).toBe(false);
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { key: "k" } });
  });

  it("is true when a non-expired row exists", async () => {
    mockFindUnique.mockResolvedValueOnce({ key: "k", expires_at: new Date("2026-06-05T13:00:00.000Z") });
    expect(await isClaimed("k", NOW)).toBe(true);
  });

  it("is false when the row has expired (TTL passed)", async () => {
    mockFindUnique.mockResolvedValueOnce({ key: "k", expires_at: new Date("2026-06-05T11:00:00.000Z") });
    expect(await isClaimed("k", NOW)).toBe(false);
  });
});

describe("idempotency.claim", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts the key with a 24h expiry (mirrors former Redis TTL)", async () => {
    await claim("k", NOW);
    const expires = new Date("2026-06-06T12:00:00.000Z");
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { key: "k" },
      create: { key: "k", expires_at: expires },
      update: { expires_at: expires },
    });
  });
});
