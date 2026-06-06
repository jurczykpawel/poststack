import { describe, it, expect, beforeAll } from "vitest";

// These paths short-circuit before any DB query, so no database is needed.
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

describe("authenticate (no-DB paths)", () => {
  it("returns null for missing cookie", async () => {
    const { authenticate } = await import("./index");
    expect(await authenticate(new Request("http://localhost/api/v1/test"))).toBeNull();
  });

  it("returns null for invalid JWT", async () => {
    const { authenticate } = await import("./index");
    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: "rs_session=garbage.token.here" },
    });
    expect(await authenticate(request)).toBeNull();
  });

  it("returns null for expired JWT", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const token = await new SignJWT({ wid: "ws-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setExpirationTime("0s")
      .sign(secret);
    await new Promise((r) => setTimeout(r, 1100));

    const { authenticate } = await import("./index");
    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: `rs_session=${token}` },
    });
    expect(await authenticate(request)).toBeNull();
  });

  it("rejects a session JWT with the wrong workspaceId when required", async () => {
    const { authenticate, signSession } = await import("./index");
    const token = await signSession("user-1", "ws-wrong");
    const request = new Request("http://localhost/api/v1/test", {
      headers: { cookie: `rs_session=${token}` },
    });
    expect(await authenticate(request, "ws-correct")).toBeNull();
  });

  it("returns null for a non-rs_ Bearer token (no API key lookup)", async () => {
    const { authenticate } = await import("./index");
    const request = new Request("http://localhost/api/v1/test", {
      headers: { authorization: "Bearer some-random-token" },
    });
    expect(await authenticate(request)).toBeNull();
  });
});

describe("invalidateSession (no-DB paths)", () => {
  it("does not crash on an invalid token", async () => {
    const { invalidateSession } = await import("./index");
    await expect(invalidateSession("garbage")).resolves.toBeUndefined();
  });

  it("does not crash on an expired token", async () => {
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
  });
});
