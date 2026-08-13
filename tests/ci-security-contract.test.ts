import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseNameFromUrl, quoteDatabaseName } from "../e2e/database-name";

const workflowDirectory = join(process.cwd(), ".github", "workflows");
const workflows = Object.fromEntries(
  readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => [name, readFileSync(join(workflowDirectory, name), "utf8")]),
);
const dockerfiles = ["docker/Dockerfile", "docker/Dockerfile.worker"]
  .map((path) => readFileSync(join(process.cwd(), path), "utf8"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CI release gates", () => {
  it("pins every third-party action to an immutable commit", () => {
    for (const [name, source] of Object.entries(workflows)) {
      const actions = [...source.matchAll(/\buses:\s*([^\s#]+)/g)].map((match) => match[1]);
      expect(actions.length, name).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action, `${name}: ${action}`).toMatch(/^[^@]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("pins workflow services and Docker base images to immutable digests", () => {
    for (const [name, source] of Object.entries(workflows)) {
      const serviceImages = [...source.matchAll(/^\s+image:\s*([^\s#]+)/gm)]
        .map((match) => match[1]);
      for (const image of serviceImages) {
        expect(image, `${name}: ${image}`).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    }

    for (const source of dockerfiles) {
      const stages = new Set<string>();
      const fromLines = [...source.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/gim)];
      expect(fromLines.length).toBeGreaterThan(0);
      for (const [, image, alias] of fromLines) {
        const isLocalStage = stages.has(image);
        if (alias) stages.add(alias);
        if (isLocalStage || image === "scratch") continue;
        expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    }

    expect(workflows["security.yml"]).toMatch(
      /ghcr\.io\/trufflesecurity\/trufflehog@sha256:[0-9a-f]{64}/,
    );
    expect(workflows["security.yml"]).not.toContain("trufflehog:latest");
  });

  it.each(["ci.yml", "release.yml"])("makes dependency and browser checks blocking in %s", (name) => {
    const source = workflows[name];
    expect(source).toContain("npm audit --audit-level=moderate");
    expect(source).toContain("npm audit signatures");
    expect(source).toContain("npm --prefix landing ci");
    expect(source).toContain("npm --prefix landing audit --audit-level=moderate");
    expect(source).toContain("npm --prefix landing audit signatures");
    expect(source).toContain("npm run test:e2e");
    expect(source).not.toMatch(/npm audit[^\n]*\|\| true/);
  });

  it("lets CI isolate browser tests on its own database", async () => {
    vi.stubEnv("E2E_DATABASE_URL", "postgresql://ci/isolated_e2e");
    vi.stubEnv("E2E_ADMIN_DATABASE_URL", "postgresql://ci/admin");

    const env = await import("../e2e/env");

    expect(env.E2E_DATABASE_URL).toBe("postgresql://ci/isolated_e2e");
    expect(env.E2E_ADMIN_DATABASE_URL).toBe("postgresql://ci/admin");
    expect(databaseNameFromUrl(env.E2E_DATABASE_URL)).toBe("isolated_e2e");
    expect(quoteDatabaseName("isolated_e2e")).toBe('"isolated_e2e"');
  });

  it("rejects unsafe database identifiers in the browser-test setup", () => {
    expect(() => databaseNameFromUrl("postgresql://ci/invalid-name")).toThrow();
    expect(() => databaseNameFromUrl("postgresql://ci/%22%3BDROP%20DATABASE%20prod%3B--")).toThrow();
    expect(() => databaseNameFromUrl("postgresql://ci/prod")).toThrow();
    expect(() => databaseNameFromUrl("postgresql://ci/poststack_test")).toThrow();
    expect(() => quoteDatabaseName('bad"name')).toThrow();
  });
});
