import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  authenticateWithScope: (...a: unknown[]) => mockAuth(...a),
}));

const mockChannelFindMany = vi.fn();
const mockMessageCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findMany: (...a: unknown[]) => mockChannelFindMany(...a) },
    message: { count: (...a: unknown[]) => mockMessageCount(...a) },
  },
}));

import { GET } from "./route";

const req = new Request("http://x/api/v1/channels");

describe("GET /api/v1/channels — held visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
  });

  it("includes a held_count for each channel", async () => {
    mockChannelFindMany.mockResolvedValueOnce([{ id: "ch-1", status: "active" }]);
    mockMessageCount.mockResolvedValueOnce(3);

    const res = await GET(req);
    const body = await res.json();

    expect(body.data[0].held_count).toBe(3);
    expect(body.data[0].is_active).toBe(true);
    expect(mockMessageCount).toHaveBeenCalledWith({
      where: { status: "held", conversation: { channel_id: "ch-1" } },
    });
  });
});
