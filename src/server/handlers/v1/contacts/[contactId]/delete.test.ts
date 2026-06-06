import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  authenticate: vi.fn(),
  authenticateWithScope: (...a: unknown[]) => mockAuth(...a),
}));

const mockContactFindFirst = vi.fn();
const mockContactDelete = vi.fn().mockResolvedValue({});
const mockCommentDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findFirst: (...a: unknown[]) => mockContactFindFirst(...a),
      delete: (...a: unknown[]) => mockContactDelete(...a),
    },
    commentLog: { deleteMany: (...a: unknown[]) => mockCommentDeleteMany(...a) },
  },
}));

const mockAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  actorFromAuth: () => ({ type: "user", id: "u-1" }),
  AuditAction: { ChannelConnected: "channel.connected", ChannelDisconnected: "channel.disconnected", ChannelDrained: "channel.drained", ContactErased: "contact.erased", MessagesPruned: "messages.pruned" },
}));

import { DELETE } from "./route";

const ctx = (contactId: string) => ({ params: Promise.resolve({ contactId }) });
const req = new Request("http://x/api/v1/contacts/co-1", { method: "DELETE" });

describe("DELETE /api/v1/contacts/:id — GDPR erase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockContactFindFirst.mockResolvedValue({
      id: "co-1",
      contact_channels: [{ platform_sender_id: "PSID-1" }, { platform_sender_id: "PSID-2" }],
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockRejectedValueOnce(new Error("no auth"));
    const res = await DELETE(req, ctx("co-1"));
    expect(res.status).toBe(401);
    expect(mockContactDelete).not.toHaveBeenCalled();
  });

  it("returns 404 when the contact is not in the workspace", async () => {
    mockContactFindFirst.mockResolvedValueOnce(null);
    const res = await DELETE(req, ctx("co-1"));
    expect(res.status).toBe(404);
    expect(mockContactDelete).not.toHaveBeenCalled();
  });

  it("deletes the contact (cascade) and its comment logs, then returns 204", async () => {
    const res = await DELETE(req, ctx("co-1"));

    expect(mockCommentDeleteMany).toHaveBeenCalledWith({
      where: { workspace_id: "ws-1", author_id: { in: ["PSID-1", "PSID-2"] } },
    });
    expect(mockContactDelete).toHaveBeenCalledWith({ where: { id: "co-1" } });
    expect(res.status).toBe(204);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", action: "contact.erased", targetId: "co-1" }),
    );
  });
});
