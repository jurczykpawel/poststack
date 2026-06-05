import { describe, it, expect, vi } from "vitest";

const mockIdemDelete = vi.fn().mockResolvedValue({ count: 0 });
const mockCooldownDelete = vi.fn().mockResolvedValue({ count: 0 });
const mockRevokedDelete = vi.fn().mockResolvedValue({ count: 0 });
vi.mock("@/lib/prisma", () => ({
  prisma: {
    outboundIdempotency: { deleteMany: (...a: unknown[]) => mockIdemDelete(...a) },
    ruleCooldown: { deleteMany: (...a: unknown[]) => mockCooldownDelete(...a) },
    revokedToken: { deleteMany: (...a: unknown[]) => mockRevokedDelete(...a) },
  },
}));

import { pruneExpired } from "./maintenance";

describe("pruneExpired", () => {
  it("deletes time-expired rows from each ephemeral table", async () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    await pruneExpired(now);
    const expected = { where: { expires_at: { lt: now } } };
    expect(mockIdemDelete).toHaveBeenCalledWith(expected);
    expect(mockCooldownDelete).toHaveBeenCalledWith(expected);
    expect(mockRevokedDelete).toHaveBeenCalledWith(expected);
  });
});
