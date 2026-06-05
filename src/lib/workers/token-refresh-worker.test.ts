import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
  },
}));

const mockNeedsReauth = vi.fn().mockResolvedValue(undefined);
const mockHealthy = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/health", () => ({
  markChannelNeedsReauth: (...a: unknown[]) => mockNeedsReauth(...a),
  markChannelHealthy: (...a: unknown[]) => mockHealthy(...a),
}));

const mockRefreshToken = vi.fn();
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({ requiresTokenRefresh: () => true, refreshToken: (...a: unknown[]) => mockRefreshToken(...a) }),
}));
vi.mock("@/lib/crypto", () => ({ decryptTokens: () => ({ access_token: "x" }), encryptTokens: () => "enc" }));

import { processTokenRefresh } from "./token-refresh-worker";
import { TokenInvalidError } from "@/lib/platforms/errors";

const helpers = { logger: { info: vi.fn() } } as never;
const activeChannel = { id: "ch-1", platform: "instagram", token_encrypted: "enc", status: "active" };

describe("processTokenRefresh — token health detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags the channel needs_reauth when the token is invalid (no silent failure)", async () => {
    mockFindUnique.mockResolvedValueOnce(activeChannel);
    mockRefreshToken.mockRejectedValueOnce(new TokenInvalidError("dead"));

    await processTokenRefresh({ channelId: "ch-1" }, helpers);

    expect(mockNeedsReauth).toHaveBeenCalledWith("ch-1", "dead");
    expect(mockHealthy).not.toHaveBeenCalled();
  });

  it("re-throws transient refresh errors so the job retries", async () => {
    mockFindUnique.mockResolvedValueOnce(activeChannel);
    mockRefreshToken.mockRejectedValueOnce(new Error("network blip"));

    await expect(processTokenRefresh({ channelId: "ch-1" }, helpers)).rejects.toThrow("network blip");
    expect(mockNeedsReauth).not.toHaveBeenCalled();
  });

  it("marks the channel healthy after a successful refresh", async () => {
    mockFindUnique.mockResolvedValueOnce(activeChannel);
    mockRefreshToken.mockResolvedValueOnce({ access_token: "new" });

    await processTokenRefresh({ channelId: "ch-1" }, helpers);

    expect(mockHealthy).toHaveBeenCalledWith("ch-1");
    expect(mockUpdate).toHaveBeenCalled(); // refreshed token persisted
  });

  it("skips disabled channels", async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeChannel, status: "disabled" });
    await processTokenRefresh({ channelId: "ch-1" }, helpers);
    expect(mockRefreshToken).not.toHaveBeenCalled();
  });
});
