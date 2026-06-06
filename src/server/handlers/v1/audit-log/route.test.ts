import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticateWithScope: (...a: unknown[]) => mockAuth(...a) }));

const mockFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}));

import { GET } from "./route";

const get = (qs = "") => new Request(`http://x/api/v1/audit-log${qs}`);

describe("GET /api/v1/audit-log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockFindMany.mockResolvedValue([{ id: "a1", action: "contact.erased" }]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockRejectedValueOnce(new Error("no auth"));
    const res = await GET(get());
    expect(res.status).toBe(401);
  });

  it("lists workspace-scoped entries newest first with a bounded limit", async () => {
    const res = await GET(get("?limit=500&offset=10"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: "a1", action: "contact.erased" }]);

    const query = mockFindMany.mock.calls[0][0];
    expect(query.where).toEqual({ workspace_id: "ws-1" });
    expect(query.orderBy).toEqual({ created_at: "desc" });
    expect(query.take).toBe(100); // clamped from 500
    expect(query.skip).toBe(10);
  });
});
