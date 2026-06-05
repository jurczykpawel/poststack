import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticateWithScope: (...a: unknown[]) => mockAuth(...a) }));

const mockConnectWithToken = vi.fn();
const mockGetProvider = vi.fn();
vi.mock("@/lib/platforms/registry", () => ({ getProvider: (...a: unknown[]) => mockGetProvider(...a) }));

const mockUpsert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/upsert", () => ({ upsertChannels: (...a: unknown[]) => mockUpsert(...a) }));

import { POST } from "./route";

function post(body: unknown) {
  return new Request("http://x/api/v1/channels/connect-token", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/channels/connect-token — manual token (REL4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
    mockConnectWithToken.mockResolvedValue([{ platformId: "P1", displayName: "Page", tokens: { access_token: "t" } }]);
    mockGetProvider.mockReturnValue({ connectWithToken: mockConnectWithToken });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockRejectedValueOnce(new Error("no auth"));
    const res = await POST(post({ platform: "facebook", token: "x".repeat(40) }));
    expect(res.status).toBe(401);
  });

  it("returns 422 on an invalid body", async () => {
    const res = await POST(post({ platform: "facebook" }));
    expect(res.status).toBe(422);
    expect(mockConnectWithToken).not.toHaveBeenCalled();
  });

  it("connects the resolved accounts in manual_token mode", async () => {
    const res = await POST(post({ platform: "facebook", token: "SYSUSER_".padEnd(40, "x") }));
    expect(mockConnectWithToken).toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith("ws-1", "facebook", expect.any(Array), {
      connectionMode: "manual_token",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toEqual({ connected: 1 });
  });

  it("returns 400 when the token resolves no accounts", async () => {
    mockConnectWithToken.mockResolvedValueOnce([]);
    const res = await POST(post({ platform: "facebook", token: "x".repeat(40) }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the token is rejected by the platform", async () => {
    mockConnectWithToken.mockRejectedValueOnce(new Error("invalid token"));
    const res = await POST(post({ platform: "facebook", token: "x".repeat(40) }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
