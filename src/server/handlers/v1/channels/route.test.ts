import { describe, it, expect, beforeEach, vi } from "vitest";

// The route transitively pulls in providers/registry which load + validate env at module top.
vi.mock("@/lib/env", () => ({
  env: {
    META_APP_ID: "test-app-id",
    META_APP_SECRET: "test-secret",
    APP_URL: "http://localhost:3000",
  },
}));

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticateWithScope: (...a: unknown[]) => mockAuth(...a) }));

const mockFindMany = vi.fn();
// The held-count query is `db.select(...).from(...).innerJoin(...).where(...).groupBy(...)`.
const chain: any = { from: () => chain, innerJoin: () => chain, where: () => chain, groupBy: () => Promise.resolve([]) };
vi.mock("@/lib/db", () => ({
  db: { query: { channels: { findMany: (...a: unknown[]) => mockFindMany(...a) } }, select: () => chain },
}));

import { GET } from "./route";

function get() {
  return new Request("http://x/api/v1/channels");
}

describe("GET /api/v1/channels — IG-Login messaging state + capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ workspaceId: "ws-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const res = await GET(get());
    expect(res.status).toBe(401);
  });

  it("surfaces messaging_token_expires_at, messaging_connection and capabilities for an IG row", async () => {
    const exp = new Date("2026-09-01T00:00:00Z");
    mockFindMany.mockResolvedValueOnce([
      {
        id: "ch-1",
        platform: "instagram",
        platform_id: "P1",
        display_name: "Acct",
        username: "acct",
        profile_picture: null,
        status: "active",
        connection_mode: "oauth",
        last_error: null,
        last_health_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        messaging_token_expires_at: exp,
      },
    ]);

    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    const c = body.data[0];
    expect(new Date(c.messaging_token_expires_at)).toEqual(exp);
    expect(c.messaging_connection).toBe("instagram_login");
    expect(c.capabilities).toEqual(expect.arrayContaining(["dm", "publish"]));
  });
});
