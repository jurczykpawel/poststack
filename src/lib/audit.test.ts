import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { create: (...a: unknown[]) => mockCreate(...a) } },
}));

import { recordAudit, actorFromAuth, AuditAction } from "./audit";
import type { AuthContext } from "@/lib/auth";

describe("recordAudit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a row mapping actor, action and target", async () => {
    await recordAudit({
      workspaceId: "ws-1",
      actor: { type: "user", id: "u-1" },
      action: AuditAction.ContactErased,
      targetType: "contact",
      targetId: "co-1",
      metadata: { reason: "gdpr" },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        workspace_id: "ws-1",
        actor_type: "user",
        actor_id: "u-1",
        action: "contact.erased",
        target_type: "contact",
        target_id: "co-1",
        metadata: { reason: "gdpr" },
      },
    });
  });

  it("never throws when the write fails (best-effort)", async () => {
    mockCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordAudit({ workspaceId: "ws-1", actor: { type: "system" }, action: "x" }),
    ).resolves.toBeUndefined();
  });
});

describe("actorFromAuth", () => {
  it("maps a session auth to a user actor", () => {
    const auth = { userId: "u-1", workspaceId: "ws-1", authMethod: "session", scopes: [] } as AuthContext;
    expect(actorFromAuth(auth)).toEqual({ type: "user", id: "u-1" });
  });

  it("maps an api-key auth to an api_key actor", () => {
    const auth = { userId: "api-key:k-1", workspaceId: "ws-1", authMethod: "api_key", scopes: [] } as AuthContext;
    expect(actorFromAuth(auth)).toEqual({ type: "api_key", id: "api-key:k-1" });
  });
});
