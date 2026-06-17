import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveLandingFile } from "./landing";

// Hermetic: a fixture dist (no Astro build, no DB). Exercises content-type, immutable caching,
// path-traversal + extension allowlist.
let dir = "";
const app = new Hono()
  .get("/", (c) => serveLandingFile(c, "index.html"))
  .get("/_astro/*", (c) => serveLandingFile(c, c.req.path.replace(/^\//, "")))
  .get("/robots.txt", (c) => serveLandingFile(c, "robots.txt"))
  // raw passthrough to probe traversal directly
  .get("/raw", (c) => serveLandingFile(c, c.req.query("p") ?? ""));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-fixture-"));
  process.env.LANDING_DIST_DIR = dir;
  writeFileSync(join(dir, "index.html"), "<!doctype html><h1>PostStack landing</h1>");
  writeFileSync(join(dir, "robots.txt"), "User-agent: *\nAllow: /\n");
  mkdirSync(join(dir, "_astro"));
  writeFileSync(join(dir, "_astro", "app.123abc.css"), "body{color:red}");
});
afterAll(() => {
  delete process.env.LANDING_DIST_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("serveLandingFile", () => {
  it("serves index.html as text/html, must-revalidate", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await res.text()).toContain("PostStack landing");
  });

  it("serves fingerprinted _astro assets immutable with correct type", async () => {
    const res = await app.request("/_astro/app.123abc.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves robots.txt as text/plain", async () => {
    const res = await app.request("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("404s a missing file", async () => {
    const res = await app.request("/_astro/nope.css");
    expect(res.status).toBe(404);
  });

  it("blocks path traversal", async () => {
    const res = await app.request("/raw?p=" + encodeURIComponent("../../../../etc/passwd"));
    expect(res.status).toBe(404);
  });

  it("404s a disallowed extension", async () => {
    writeFileSync(join(dir, "secret.env"), "X=1");
    const res = await app.request("/raw?p=secret.env");
    expect(res.status).toBe(404);
  });
});
