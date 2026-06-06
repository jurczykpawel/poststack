import { describe, it, expect, beforeAll } from "vitest";
import type { AuthContext } from "@/lib/auth";

// audit.ts imports the db client (which needs DATABASE_URL at load); set a value
// before importing. actorFromAuth itself is pure (no query). recordAudit's DB
// write + best-effort behaviour are covered by audit.integration.test.ts.
let actorFromAuth: typeof import("./audit").actorFromAuth;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  ({ actorFromAuth } = await import("./audit"));
});

describe("actorFromAuth", () => {
  it("maps a session auth to a user actor", () => {
    const auth = { userId: "u-1", workspaceId: "ws-1", authMethod: "session", scopes: [] } as AuthContext;
    expect(actorFromAuth(auth)).toEqual({ type: "user", id: "u-1" });
  });

  it("maps an api-key auth to an api_key actor", () => {
    const auth = { userId: "api-key:k-1", workspaceId: "ws-1", authMethod: "api_key", scopes: [] } as AuthContext;
    expect(actorFromAuth(auth)).toEqual({ type: "api_key", id: "api-key:k-1" });
  });
});
