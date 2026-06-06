import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  authenticateWithScope: (...a: unknown[]) => mockAuth(...a),
}));

const mockFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { channel: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } },
}));

const mockDrain = vi.fn();
vi.mock("@/lib/channels/drain", () => ({ drainChannel: (...a: unknown[]) => mockDrain(...a) }));

const mockAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  actorFromAuth: () => ({ type: "user", id: "u-1" }),
  AuditAction: { ChannelConnected: "channel.connected", ChannelDisconnected: "channel.disconnected", ChannelDrained: "channel.drained", ContactErased: "contact.erased", MessagesPruned: "messages.pruned" },
}));

import { POST } from "./route";

function ctx(channelId: string) {
  return { params: Promise.resolve({ channelId }) };
}
const req = new Request("http://x/api/v1/channels/ch-1/drain", { method: "POST" });

describe("POST /api/v1/channels/:channelId/drain — force drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockFindFirst.mockResolvedValue({ id: "ch-1" });
    mockDrain.mockResolvedValue({ enqueued: 2, expired: 1 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockRejectedValueOnce(new Error("no auth"));
    const res = await POST(req, ctx("ch-1"));
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it("returns 404 when the channel is not in the workspace", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await POST(req, ctx("ch-1"));
    expect(res.status).toBe(404);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it("drains the channel and returns the counts", async () => {
    const res = await POST(req, ctx("ch-1"));
    expect(mockDrain).toHaveBeenCalledWith("ch-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ enqueued: 2, expired: 1 });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", action: "channel.drained", targetId: "ch-1" }),
    );
  });
});
