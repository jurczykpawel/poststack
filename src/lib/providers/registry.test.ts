import { describe, it, expect, beforeEach } from "vitest";
import { createRegistry } from "./registry";
import type { Provider } from "./types";

function fakeProvider(id: string): Provider {
  return {
    id,
    label: id,
    capabilities: () => [],
    connectionModes: () => ["manual_token"],
    requiresTokenRefresh: () => false,
    healthCheck: async () => ({ accountId: "a" }),
    refreshToken: async (t) => t,
    publish: async () => ({ providerHandle: "h" }),
  };
}

describe("provider registry", () => {
  let reg: ReturnType<typeof createRegistry>;
  beforeEach(() => {
    reg = createRegistry();
  });

  it("registers and gets a provider", () => {
    reg.register(fakeProvider("meta"));
    expect(reg.get("meta").id).toBe("meta");
    expect(reg.has("meta")).toBe(true);
  });

  it("throws on unknown provider", () => {
    expect(() => reg.get("nope")).toThrow();
  });

  it("throws on duplicate registration", () => {
    reg.register(fakeProvider("meta"));
    expect(() => reg.register(fakeProvider("meta"))).toThrow();
  });

  it("lists registered ids", () => {
    reg.register(fakeProvider("meta"));
    reg.register(fakeProvider("tiktok"));
    expect(
      reg
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["meta", "tiktok"]);
  });
});
