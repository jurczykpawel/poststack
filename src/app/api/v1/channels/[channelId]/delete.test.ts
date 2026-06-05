import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  authenticate: vi.fn(),
  authenticateWithScope: (...a: unknown[]) => mockAuth(...a),
}));

const mockDeleteMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { channel: { deleteMany: (...a: unknown[]) => mockDeleteMany(...a) } },
}));

const mockAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  actorFromAuth: () => ({ type: "user", id: "u-1" }),
  AuditAction: { ChannelDisconnected: "channel.disconnected" },
}));

import { DELETE } from "./route";

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const req = new Request("http://x/api/v1/channels/ch-1", { method: "DELETE" });

describe("DELETE /api/v1/channels/:id — disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("returns 404 and records nothing when the channel is absent", async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 0 });
    const res = await DELETE(req, ctx("ch-1"));
    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("disconnects the channel and records an audit entry", async () => {
    const res = await DELETE(req, ctx("ch-1"));
    expect(res.status).toBe(204);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", action: "channel.disconnected", targetId: "ch-1" }),
    );
  });
});
