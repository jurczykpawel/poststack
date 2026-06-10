import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticateWithScope: (...a: unknown[]) => mockAuth(...a) }));

const mockPrune = vi.fn();
// MAX_RETENTION_DAYS must be mirrored here: route.ts reads it at import time to bound the
// older_than_days schema (z.number().max(MAX_RETENTION_DAYS)); a missing export → undefined → throw
// on module load.
vi.mock("@/lib/retention", () => ({ pruneWorkspaceMessages: (...a: unknown[]) => mockPrune(...a), MAX_RETENTION_DAYS: 3650 }));

const mockAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  actorFromAuth: () => ({ type: "user", id: "u-1" }),
  AuditAction: { ChannelConnected: "channel.connected", ChannelDisconnected: "channel.disconnected", ChannelDrained: "channel.drained", ContactErased: "contact.erased", MessagesPruned: "messages.pruned" },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  new Request("http://x/api/v1/messages/prune", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/v1/messages/prune — manual retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockPrune.mockResolvedValue({ deletedMessages: 5, deletedComments: 2, deletedConversations: 1 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockRejectedValueOnce(new Error("no auth"));
    const res = await POST(post({ older_than_days: 30 }));
    expect(res.status).toBe(401);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it("returns 422 on an invalid body", async () => {
    const res = await POST(post({ older_than_days: 0 }));
    expect(res.status).toBe(422);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it("prunes the workspace's messages older than the given days", async () => {
    const res = await POST(post({ older_than_days: 30 }));

    expect(mockPrune).toHaveBeenCalledWith("ws-1", 30);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ deletedMessages: 5, deletedComments: 2, deletedConversations: 1 });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", action: "messages.pruned" }),
    );
  });
});
