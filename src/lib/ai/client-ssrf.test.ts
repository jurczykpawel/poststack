vi.mock("@/lib/ai/provider-store", () => ({ storedProviderChain: async () => null, hasStoredProviders: async () => null }));
import { describe, it, expect, beforeEach, vi } from "vitest";

// AIPROVIDER1: the production call path enforces the private-target policy (no mocked aiFetch here).
vi.mock("@/lib/settings/config", () => ({ getConfig: async (key: string) => process.env[key] ?? "" }));
const logGeneration = vi.fn(async (_entry: { error: string | null }) => {});
vi.mock("@/lib/ai/generation-log", () => ({ logGeneration: (e: { error: string | null }) => logGeneration(e) }));

const ask = async () => {
  vi.resetModules();
  return (await import("./client")).chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u", timeoutMs: 2000 });
};

beforeEach(() => {
  process.env.AI_API_KEY = "k";
  process.env.AI_PROVIDER = "custom";
  delete process.env.AI_ALLOWED_PRIVATE_TARGETS;
  logGeneration.mockClear();
});

describe("chatComplete — private target policy", () => {
  it("refuses a loopback Base URL by default and logs why", async () => {
    process.env.AI_BASE_URL = "http://127.0.0.1:9/v1";
    expect(await ask()).toBeNull();
    expect(logGeneration.mock.calls[0]![0].error).toBe("blocked_target");
  });

  it("refuses cloud metadata even when listed", async () => {
    process.env.AI_BASE_URL = "http://169.254.169.254/v1";
    process.env.AI_ALLOWED_PRIVATE_TARGETS = "169.254.169.254";
    expect(await ask()).toBeNull();
    expect(logGeneration.mock.calls[0]![0].error).toBe("blocked_target");
  });

  it("lets a listed loopback target through to the network (here: nothing listens on the port)", async () => {
    process.env.AI_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.AI_ALLOWED_PRIVATE_TARGETS = "127.0.0.1:9";
    expect(await ask()).toBeNull();
    expect(logGeneration.mock.calls[0]![0].error).not.toBe("blocked_target");
  });
});
