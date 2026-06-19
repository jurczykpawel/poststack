import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Pure (no DB): collectDeployment() reports versions, deployment flags and integration booleans
// derived from the environment — and NEVER any secret value. storageLabel() maps a configured
// storage endpoint to a short provider label.

// collect.ts imports the response-times lib (which transitively pulls the db singleton). To keep
// this suite DB-free we mock those modules; collectDeployment never touches the db anyway.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/metrics/response-times", () => ({
  getInstanceResponseTimeStats: vi.fn(),
  DEFAULT_WINDOW_DAYS: 30,
}));

const REQUIRED = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_SECRET: "test-secret-at-least-32-characters-long",
  ENCRYPTION_KEY: "test-encryption-key-at-least-32-characters-long",
  APP_URL: "https://app.example.com",
  CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
};

async function loadCollect(over: Record<string, string | undefined>) {
  // env.ts reads process.env once at module load, so reset the registry and reload per case.
  vi.resetModules();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("STORAGE_") || k.startsWith("META_") || k.startsWith("GOOGLE_") || k.startsWith("AI_")) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, REQUIRED, over);
  // Re-mock after resetModules (vi.mock hoists, but resetModules clears the registry).
  vi.doMock("@/lib/db", () => ({ db: {} }));
  vi.doMock("@/lib/metrics/response-times", () => ({
    getInstanceResponseTimeStats: vi.fn(),
    DEFAULT_WINDOW_DAYS: 30,
  }));
  return import("./collect");
}

const SAVED = { ...process.env };
beforeEach(() => {
  process.env = { ...SAVED };
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("storageLabel", () => {
  it("maps known endpoints to a short label", async () => {
    const { storageLabel } = await loadCollect({});
    expect(storageLabel("https://s3.us-west-002.backblazeb2.com")).toBe("b2");
    expect(storageLabel("https://abc123.r2.cloudflarestorage.com")).toBe("r2");
    expect(storageLabel("https://s3.eu-central-1.amazonaws.com")).toBe("s3");
  });

  it("falls back to a generic s3 label for an unknown endpoint", async () => {
    const { storageLabel } = await loadCollect({});
    expect(storageLabel("https://minio.internal.example.com")).toBe("s3");
  });

  it("returns null when no endpoint is configured", async () => {
    const { storageLabel } = await loadCollect({});
    expect(storageLabel("")).toBeNull();
    expect(storageLabel(undefined)).toBeNull();
  });
});

describe("collectDeployment", () => {
  it("reports the runtime/host shape with the expected fields and types", async () => {
    const { collectDeployment } = await loadCollect({});
    const d = collectDeployment();
    expect(typeof d.app_version).toBe("string");
    expect(d.app_version.length).toBeGreaterThan(0);
    expect(d.runtime).toBe("bun");
    expect(typeof d.runtime_version).toBe("string");
    expect(typeof d.os).toBe("string");
    expect(typeof d.arch).toBe("string");
    expect(typeof d.cpu_count).toBe("number");
    expect(d.cpu_count).toBeGreaterThan(0);
    expect(typeof d.mem_total_mb).toBe("number");
    expect(d.mem_total_mb).toBeGreaterThan(0);
    expect(["development", "production", "test"]).toContain(d.node_env);
    expect(typeof d.registration_enabled).toBe("boolean");
    expect(typeof d.history_retention_days).toBe("number");
    expect(Array.isArray(d.platforms_enabled)).toBe(true);
  });

  it("integration booleans reflect env presence (all off)", async () => {
    const { collectDeployment } = await loadCollect({});
    const d = collectDeployment();
    expect(d.integrations.google).toBe(false);
    expect(d.integrations.ai).toBe(false);
    expect(d.integrations.storage).toBeNull();
  });

  it("integration booleans reflect env presence (all on)", async () => {
    const { collectDeployment } = await loadCollect({
      GOOGLE_CLIENT_ID: "g-client-id",
      AI_API_KEY: "sk-secret-key-value-should-never-leak",
      STORAGE_ENDPOINT: "https://s3.us-west-002.backblazeb2.com",
    });
    const d = collectDeployment();
    expect(d.integrations.google).toBe(true);
    expect(d.integrations.ai).toBe(true);
    expect(d.integrations.storage).toBe("b2");
  });

  it("registration_enabled reflects the REGISTRATION_ENABLED flag", async () => {
    const off = (await loadCollect({ REGISTRATION_ENABLED: "false" })).collectDeployment();
    expect(off.registration_enabled).toBe(false);
    const on = (await loadCollect({ REGISTRATION_ENABLED: "true" })).collectDeployment();
    expect(on.registration_enabled).toBe(true);
  });

  it("never leaks any secret value into the deployment object", async () => {
    const secrets = {
      JWT_SECRET: "jwt-secret-VALUE-must-not-appear-anywhere-xyz",
      ENCRYPTION_KEY: "encryption-KEY-VALUE-must-not-appear-anywhere-xyz",
      AI_API_KEY: "sk-AI-secret-VALUE-must-not-appear-anywhere-xyz",
      GOOGLE_CLIENT_SECRET: "google-CLIENT-secret-VALUE-xyz",
      META_APP_SECRET: "meta-APP-secret-VALUE-xyz",
      META_APP_ID: "meta-app-id-12345",
      GOOGLE_CLIENT_ID: "google-client-id-67890",
      STORAGE_ENDPOINT: "https://s3.us-west-002.backblazeb2.com",
      STORAGE_ACCESS_KEY_ID: "storage-ACCESS-key-VALUE-xyz",
      STORAGE_SECRET_ACCESS_KEY: "storage-SECRET-access-VALUE-xyz",
    };
    const { collectDeployment } = await loadCollect(secrets);
    const json = JSON.stringify(collectDeployment());
    for (const v of Object.values(secrets)) {
      // The B2 endpoint host is a non-secret label source; its bucket-less host is fine, but the
      // raw access keys / app secrets / jwt / encryption key must never appear.
      if (v === secrets.STORAGE_ENDPOINT) continue;
      expect(json).not.toContain(v);
    }
    // No field literally named like a secret carries a value either.
    expect(json.toLowerCase()).not.toContain("secret-value");
  });
});
