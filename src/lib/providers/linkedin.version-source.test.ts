import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LINKEDIN_API_VERSION } from "./linkedin";

const dir = __dirname;

it("LinkedIn API version literal lives only in its definition (linkedin.ts)", () => {
  const offenders = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && f !== "linkedin.ts" && f !== "linkedin.version-source.test.ts")
    .filter((f) => readFileSync(join(dir, f), "utf8").includes(LINKEDIN_API_VERSION));
  expect(offenders).toEqual([]);
});

it("linkedin.ts defines the version once and the REST headers use the constant", () => {
  const src = readFileSync(join(dir, "linkedin.ts"), "utf8");
  expect(src.split(LINKEDIN_API_VERSION).length - 1).toBe(1);
  expect(src).toContain(`"LinkedIn-Version": LINKEDIN_API_VERSION`);
});
