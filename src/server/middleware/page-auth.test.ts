import { describe, it, expect, beforeAll, vi } from "vitest";

// page-auth imports @/lib/env (validated at import time), so set the required env before importing.
beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

const SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET!);

// Minimal stand-in for the Hono context requireSession touches: the cookie header, redirect, and
// header setter. Records whether a redirect happened so we can assert pass vs reject.
function fakeContext(cookie?: string) {
  const redirects: string[] = [];
  const c = {
    req: { header: (name: string) => (name.toLowerCase() === "cookie" ? cookie : undefined) },
    redirect: (path: string) => {
      redirects.push(path);
      return new Response(null, { status: 302, headers: { location: path } });
    },
    header: () => {},
  };
  return { c, redirects };
}

async function signWith(alg: "HS256" | "HS512") {
  const { SignJWT } = await import("jose");
  return new SignJWT({ wid: "ws-1" })
    .setProtectedHeader({ alg })
    .setSubject("user-1")
    .setIssuer("stack")
    .setAudience("stack")
    .setExpirationTime("1h")
    .sign(SECRET());
}

describe("requireSession — JWT algorithm pin", () => {
  it("calls next() for a valid HS256 session token", async () => {
    const { requireSession } = await import("./page-auth");
    const token = await signWith("HS256");
    const { c, redirects } = fakeContext(`session=${token}`);
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requireSession(c as any, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(redirects).toHaveLength(0);
  });

  it("rejects a token signed with a non-pinned algorithm (HS512) and redirects to /login", async () => {
    const { requireSession } = await import("./page-auth");
    // Same symmetric secret, only the header alg differs — without the ["HS256"] pin jose would
    // accept this; with the pin it must be rejected (the exact future-refactor footgun this pin closes).
    const token = await signWith("HS512");
    const { c, redirects } = fakeContext(`session=${token}`);
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requireSession(c as any, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(redirects).toEqual(["/login"]);
  });

  it("rejects an unsecured (alg:none) token", async () => {
    const { requireSession } = await import("./page-auth");
    const { UnsecuredJWT } = await import("jose");
    const token = new UnsecuredJWT({ wid: "ws-1", sub: "user-1" })
      .setIssuer("stack")
      .setAudience("stack")
      .setExpirationTime("1h")
      .encode();
    const { c, redirects } = fakeContext(`session=${token}`);
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requireSession(c as any, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(redirects).toEqual(["/login"]);
  });

  it("redirects to /login when no session cookie is present", async () => {
    const { requireSession } = await import("./page-auth");
    const { c, redirects } = fakeContext(undefined);
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await requireSession(c as any, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(redirects).toEqual(["/login"]);
  });
});
