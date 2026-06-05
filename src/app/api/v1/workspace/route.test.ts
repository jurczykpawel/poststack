import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticateWithScope: (...a: unknown[]) => mockAuth(...a) }));

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspace: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
  },
}));

import { GET, PATCH } from "./route";

const patch = (body: unknown) =>
  new Request("http://x/api/v1/workspace", { method: "PATCH", body: JSON.stringify(body) });
const get = () => new Request("http://x/api/v1/workspace");

describe("workspace settings — message retention (DATA1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockFindUnique.mockResolvedValue({ id: "ws-1", name: "W", message_retention_days: 30 });
    mockUpdate.mockResolvedValue({ id: "ws-1", name: "W", message_retention_days: 30 });
  });

  it("GET returns the current retention policy", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.message_retention_days).toBe(30);
  });

  it("PATCH 401 when unauthenticated", async () => {
    mockAuth.mockRejectedValueOnce(new Error("no auth"));
    const res = await PATCH(patch({ message_retention_days: 30 }));
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("PATCH 422 for a non-positive retention value", async () => {
    const res = await PATCH(patch({ message_retention_days: 0 }));
    expect(res.status).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("PATCH sets the retention policy", async () => {
    mockUpdate.mockResolvedValueOnce({ id: "ws-1", name: "W", message_retention_days: 90 });
    const res = await PATCH(patch({ message_retention_days: 90 }));
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { message_retention_days: 90 },
      select: { id: true, name: true, message_retention_days: true },
    });
    const body = await res.json();
    expect(body.data.message_retention_days).toBe(90);
  });

  it("PATCH null disables retention (keep forever)", async () => {
    mockUpdate.mockResolvedValueOnce({ id: "ws-1", name: "W", message_retention_days: null });
    const res = await PATCH(patch({ message_retention_days: null }));
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][0].data.message_retention_days).toBeNull();
  });
});
