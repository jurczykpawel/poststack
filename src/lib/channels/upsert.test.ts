import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      upsert: (...a: unknown[]) => mockUpsert(...a),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({ encryptTokens: () => "enc" }));

const mockAddJob = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/queue/client", () => ({ addJob: (...a: unknown[]) => mockAddJob(...a) }));

import { upsertChannels } from "./upsert";

const account = {
  platformId: "PAGE-1",
  displayName: "My Page",
  username: null,
  profilePicture: null,
  tokens: { access_token: "tok" },
} as never;

describe("upsertChannels — REL5 auto-drain on reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: "ch-1" });
  });

  it("drains held messages when a previously-broken channel is reconnected", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "needs_reauth" });

    await upsertChannels("ws-1", "facebook" as never, [account]);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockAddJob).toHaveBeenCalledWith("drain-channel", { channelId: "ch-1" });
  });

  it("does NOT drain a freshly-connected channel", async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    await upsertChannels("ws-1", "facebook" as never, [account]);

    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it("does NOT drain a channel that was already active", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "active" });

    await upsertChannels("ws-1", "facebook" as never, [account]);

    expect(mockAddJob).not.toHaveBeenCalled();
  });
});
