import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

describe("provider registry", () => {
  it("registers the built-in providers synchronously on import (no deferred race)", async () => {
    const { getSupportedPlatforms } = await import("./registry");
    expect(getSupportedPlatforms().sort()).toEqual(["facebook", "instagram", "telegram"]);
  });

  it("getProvider returns the right provider instance for each platform", async () => {
    const { getProvider } = await import("./registry");
    const { FacebookProvider } = await import("./facebook");
    const { InstagramProvider } = await import("./instagram");
    expect(getProvider("facebook")).toBeInstanceOf(FacebookProvider);
    expect(getProvider("instagram")).toBeInstanceOf(InstagramProvider);
  });

  it("throws for an unregistered platform", async () => {
    const { getProvider } = await import("./registry");
    expect(() => getProvider("tiktok" as never)).toThrow(/No provider registered/);
  });
});
