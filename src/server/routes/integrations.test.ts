import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/response";
import type { Storage } from "@/lib/storage/types";

// integrationsRoutes pulls in @/lib/media/service → @/lib/db, which throws at import without
// DATABASE_URL. Deps are fully injected (mock register + mock storage) so the DB pool never connects;
// we only need the env present to satisfy the import guards, hence the dynamic import after setup.
let integrationsRoutes: typeof import("./integrations").integrationsRoutes;

const SECRET = "test-secret-key";
const WS = "00000000-0000-0000-0000-0000000000aa";

function signed(bodyObj: unknown, ts = Date.now().toString(), secret = SECRET): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(bodyObj);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return {
    body,
    headers: {
      "x-reelstack-signature": sig,
      "x-reelstack-timestamp": ts,
      "content-type": "application/json",
    },
  };
}

const VALID_PAYLOAD = {
  event: "reel.completed",
  status: "completed",
  jobId: "job-123",
  outputUrl: "https://cdn.test/reel.mp4",
  outputSha256: "a".repeat(64),
};

const mockStorage = {
  head: vi.fn(),
  putBytes: vi.fn(),
  publicUrl: vi.fn(() => "https://cdn.test/reel.mp4"),
  delete: vi.fn(),
} as unknown as Storage;

describe("integrations routes (ReelStack webhook)", () => {
  let mockRegister: ReturnType<typeof vi.fn>;
  let app: Hono;
  const origSecret = process.env.REELSTACK_WEBHOOK_SECRET;
  const origWs = process.env.REELSTACK_WEBHOOK_WORKSPACE_ID;

  const hit = (body: string, headers: Record<string, string>) =>
    app.request("/integrations/reelstack/webhook", { method: "POST", headers, body });

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://test:test@localhost:5433/test";
    process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
    process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
    process.env.APP_URL ??= "http://localhost:3000";
    process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
    ({ integrationsRoutes } = await import("./integrations"));
  });

  beforeEach(() => {
    mockRegister = vi.fn().mockResolvedValue({ id: "media-1", checksum: "a".repeat(64) });
    app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.route("/", integrationsRoutes({ registerKnownMedia: mockRegister as any, storage: mockStorage }));
    process.env.REELSTACK_WEBHOOK_SECRET = SECRET;
    process.env.REELSTACK_WEBHOOK_WORKSPACE_ID = WS;
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("REELSTACK_WEBHOOK_SECRET", origSecret);
    restore("REELSTACK_WEBHOOK_WORKSPACE_ID", origWs);
  });

  it("1. secret unset → 404 (off by default), register NOT called", async () => {
    delete process.env.REELSTACK_WEBHOOK_SECRET;
    const { body, headers } = signed(VALID_PAYLOAD);
    const res = await hit(body, headers);
    expect(res.status).toBe(404);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("1b. workspace id unset → 404 (not fully configured), register NOT called", async () => {
    delete process.env.REELSTACK_WEBHOOK_WORKSPACE_ID;
    const { body, headers } = signed(VALID_PAYLOAD);
    const res = await hit(body, headers);
    expect(res.status).toBe(404);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("2. valid signature + reel.completed → 200, register called once into the configured workspace", async () => {
    const { body, headers } = signed(VALID_PAYLOAD);
    const res = await hit(body, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { received: true } });
    expect(mockRegister).toHaveBeenCalledOnce();
    expect(mockRegister).toHaveBeenCalledWith(
      { checksum: "a".repeat(64), mime: "video/mp4", kind: "video" },
      expect.objectContaining({ storage: expect.anything() }),
      WS,
    );
  });

  it("3. tampered signature → 401, register NOT called", async () => {
    const { body, headers } = signed(VALID_PAYLOAD);
    const res = await hit(body, { ...headers, "x-reelstack-signature": "dead".repeat(16) });
    expect(res.status).toBe(401);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("4. stale timestamp (10 min old) → 401", async () => {
    const staleTs = (Date.now() - 10 * 60 * 1000).toString();
    const { body, headers } = signed(VALID_PAYLOAD, staleTs);
    const res = await hit(body, headers);
    expect(res.status).toBe(401);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("5. register throws ApiError(not_present) → 200 (acked, swallowed — ReelStack won't replay)", async () => {
    mockRegister.mockRejectedValue(new ApiError("not_present", "Object not in bucket", 422));
    const { body, headers } = signed(VALID_PAYLOAD);
    const res = await hit(body, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { received: true } });
  });

  it("6. event not reel.completed → 200, register NOT called", async () => {
    const { body, headers } = signed({ ...VALID_PAYLOAD, event: "reel.failed", status: "failed" });
    const res = await hit(body, headers);
    expect(res.status).toBe(200);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("7. over-cap body (>256 KB) → 413, register NOT called", async () => {
    const { body, headers } = signed({ ...VALID_PAYLOAD, pad: "x".repeat(300 * 1024) });
    const res = await hit(body, headers);
    expect(res.status).toBe(413);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
