import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Set env before any imports
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

// Mock Prisma
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn().mockResolvedValue({});
const mockUserFindUnique = vi.fn().mockResolvedValue({ id: "user-123" });
const mockRevokedFindUnique = vi.fn().mockResolvedValue(null);
const mockRevokedUpsert = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    revokedToken: {
      findUnique: (...args: unknown[]) => mockRevokedFindUnique(...args),
      upsert: (...args: unknown[]) => mockRevokedUpsert(...args),
    },
  },
}));

describe("authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Session JWT (happy path) ──────────────────────────────────

  it("authenticates valid session JWT cookie", async () => {
    const { authenticate, signSession } = await import("./index");
    const token = await signSession("user-123", "ws-456");

    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: `rs_session=${token}` },
    });

    const auth = await authenticate(request);
    expect(auth).not.toBeNull();
    expect(auth!.userId).toBe("user-123");
    expect(auth!.workspaceId).toBe("ws-456");
    expect(auth!.authMethod).toBe("session");
    expect(auth!.scopes).toEqual([]);
  });

  // ── Session JWT (error paths) ─────────────────────────────────

  it("returns null for missing cookie", async () => {
    const { authenticate } = await import("./index");
    const request = new Request("http://localhost/api/v1/test");

    const auth = await authenticate(request);
    expect(auth).toBeNull();
  });

  it("returns null for invalid JWT", async () => {
    const { authenticate } = await import("./index");
    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: "rs_session=garbage.token.here" },
    });

    const auth = await authenticate(request);
    expect(auth).toBeNull();
  });

  it("returns null for expired JWT", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT({ wid: "ws-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setExpirationTime("0s")
      .sign(secret);

    // Wait a moment for expiry
    await new Promise((r) => setTimeout(r, 1100));

    const { authenticate } = await import("./index");
    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: `rs_session=${token}` },
    });

    const auth = await authenticate(request);
    expect(auth).toBeNull();
  });

  it("returns null for revoked JWT (denylist)", async () => {
    const { authenticate, signSession } = await import("./index");
    const token = await signSession("user-1", "ws-1");

    // Simulate denylist hit (non-expired revoked entry)
    mockRevokedFindUnique.mockResolvedValueOnce({ jti: "x", expires_at: new Date(Date.now() + 60_000) });

    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: `rs_session=${token}` },
    });

    const auth = await authenticate(request);
    expect(auth).toBeNull();
    expect(mockRevokedFindUnique).toHaveBeenCalled();
  });

  it("rejects JWT with wrong workspaceId when required", async () => {
    const { authenticate, signSession } = await import("./index");
    const token = await signSession("user-1", "ws-wrong");

    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: `rs_session=${token}` },
    });

    const auth = await authenticate(request, "ws-correct");
    expect(auth).toBeNull();
  });

  // ── API Key (happy path) ──────────────────────────────────────

  it("authenticates valid API key with scopes", async () => {
    const { authenticate, generateApiKey } = await import("./index");
    const { plaintext } = generateApiKey();

    mockFindUnique.mockResolvedValueOnce({
      id: "key-1",
      workspace_id: "ws-1",
      scopes: ["channels:read", "contacts:read"],
      expires_at: null,
    });

    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: `Bearer ${plaintext}` },
    });

    const auth = await authenticate(request);
    expect(auth).not.toBeNull();
    expect(auth!.userId).toBe("api-key:key-1");
    expect(auth!.workspaceId).toBe("ws-1");
    expect(auth!.authMethod).toBe("api_key");
    expect(auth!.scopes).toEqual(["channels:read", "contacts:read"]);
  });

  it("authenticates API key with empty scopes (full access)", async () => {
    const { authenticate, generateApiKey } = await import("./index");
    const { plaintext } = generateApiKey();

    mockFindUnique.mockResolvedValueOnce({
      id: "key-2",
      workspace_id: "ws-1",
      scopes: [],
      expires_at: null,
    });

    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: `Bearer ${plaintext}` },
    });

    const auth = await authenticate(request);
    expect(auth).not.toBeNull();
    expect(auth!.scopes).toEqual([]);
  });

  // ── API Key (error paths) ─────────────────────────────────────

  it("returns null for unknown API key", async () => {
    const { authenticate } = await import("./index");
    mockFindUnique.mockResolvedValueOnce(null);

    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: "Bearer rs_live_nonexistent0000000000000000" },
    });

    const auth = await authenticate(request);
    expect(auth).toBeNull();
  });

  it("returns null for expired API key", async () => {
    const { authenticate, generateApiKey } = await import("./index");
    const { plaintext } = generateApiKey();

    mockFindUnique.mockResolvedValueOnce({
      id: "key-3",
      workspace_id: "ws-1",
      scopes: [],
      expires_at: new Date("2020-01-01"),
    });

    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: `Bearer ${plaintext}` },
    });

    const auth = await authenticate(request);
    expect(auth).toBeNull();
  });

  it("rejects API key for wrong workspace", async () => {
    const { authenticate, generateApiKey } = await import("./index");
    const { plaintext } = generateApiKey();

    mockFindUnique.mockResolvedValueOnce({
      id: "key-4",
      workspace_id: "ws-other",
      scopes: [],
      expires_at: null,
    });

    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: `Bearer ${plaintext}` },
    });

    const auth = await authenticate(request, "ws-mine");
    expect(auth).toBeNull();
  });

  it("returns null for non-rs_ Bearer token", async () => {
    const { authenticate } = await import("./index");

    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: "Bearer some-random-token" },
    });

    // No API key lookup, falls through to session (no cookie) -> null
    const auth = await authenticate(request);
    expect(auth).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

describe("invalidateSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds jti to the Postgres denylist with an expiry within the token lifetime", async () => {
    const { signSession, invalidateSession } = await import("./index");
    const token = await signSession("user-1", "ws-1");

    await invalidateSession(token);

    expect(mockRevokedUpsert).toHaveBeenCalledTimes(1);
    const arg = mockRevokedUpsert.mock.calls[0][0];
    expect(typeof arg.where.jti).toBe("string");
    const secondsLeft = (arg.create.expires_at.getTime() - Date.now()) / 1000;
    expect(secondsLeft).toBeGreaterThan(0);
    expect(secondsLeft).toBeLessThanOrEqual(7 * 24 * 60 * 60 + 5);
  });

  it("does not crash on invalid token", async () => {
    const { invalidateSession } = await import("./index");
    await expect(invalidateSession("garbage")).resolves.toBeUndefined();
    expect(mockRevokedUpsert).not.toHaveBeenCalled();
  });

  it("does not crash on expired token", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT({ wid: "ws-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setJti("jti-expired")
      .setExpirationTime("0s")
      .sign(secret);

    await new Promise((r) => setTimeout(r, 1100));

    const { invalidateSession } = await import("./index");
    await expect(invalidateSession(token)).resolves.toBeUndefined();
    // Expired token can't be verified -> no denylist entry (already expired anyway)
    expect(mockRevokedUpsert).not.toHaveBeenCalled();
  });
});
