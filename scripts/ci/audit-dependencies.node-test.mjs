import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAudit, runAudit } from "./audit-dependencies.mjs";

const beforeExpiry = Date.parse("2026-11-24T23:59:59.999Z");
const expiry = beforeExpiry + 1;
// Relevant fields captured from npm audit --json (report version 2).
const advisory = {
  source: 1247710,
  name: "picomatch",
  dependency: "picomatch",
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  severity: "high",
  range: "<=4.0.7",
};
function entry(name, via, severity = "high") {
  return { name, severity, isDirect: false, via, effects: [], range: "*", nodes: [`node_modules/${name}`], fixAvailable: false };
}
function report(entries = {
  picomatch: entry("picomatch", [{ ...advisory }]),
  fdir: entry("fdir", ["picomatch"]),
  tinyglobby: entry("tinyglobby", ["fdir", "picomatch"]),
}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(entries).length };
  for (const value of Object.values(entries)) counts[value.severity]++;
  return { auditReportVersion: 2, vulnerabilities: entries, metadata: { vulnerabilities: counts } };
}
const check = (value, threshold = "high", now = beforeExpiry) => checkAudit(value, 1, threshold, now);

test("accepts the exact cause and its full dependency chain", () => {
  for (const threshold of ["high", "moderate"]) {
    assert.deepEqual(check(report(), threshold), { blocked: [], accepted: 3 });
  }
  assert.deepEqual(checkAudit(report({}), 0, "moderate", expiry), { blocked: [], accepted: 0 });
});

test("stops accepting at the expiration instant", () => {
  assert.equal(check(report(), "high", beforeExpiry).blocked.length, 0);
  assert.equal(check(report(), "high", expiry).blocked.length, 3);
  assert.equal(check(report(), "high", expiry + 1).blocked.length, 3);
});

test("new causes on the same package block all dependent entries", () => {
  const value = report();
  value.vulnerabilities.picomatch.via.push({ ...advisory, source: 9999999, url: "https://github.com/advisories/GHSA-other" });
  assert.equal(check(value).blocked.length, 3);
});

test("exact identity and high severity are required", () => {
  for (const [field, replacement] of [
    ["url", advisory.url.toUpperCase()], ["url", `${advisory.url}/`],
    ["name", "Picomatch"], ["dependency", "other"], ["severity", "critical"],
  ]) {
    const value = report();
    value.vulnerabilities.picomatch.via[0][field] = replacement;
    assert.equal(check(value).blocked.length, 3);
  }
  const value = report({ other: entry("other", [{ ...advisory }]) });
  assert.equal(check(value).blocked.length, 1);
  const critical = report({ picomatch: entry("picomatch", [{ ...advisory }], "critical") });
  assert.equal(check(critical).blocked.length, 1);
});

test("unrelated causes retain each configured threshold", () => {
  for (const severity of ["low", "moderate", "high", "critical"]) {
    const value = report();
    value.vulnerabilities.other = entry("other", [{ ...advisory, name: "other", dependency: "other", severity }], severity);
    const complete = report(value.vulnerabilities);
    assert.equal(check(complete, "high").blocked.length, ["high", "critical"].includes(severity) ? 1 : 0);
    assert.equal(check(complete, "moderate").blocked.length, severity === "low" ? 0 : 1);
  }
});

test("mixed causes, unknown references, and cycles do not pass", () => {
  const mixed = report();
  mixed.vulnerabilities.fdir.via.push({ ...advisory, name: "fdir", dependency: "fdir" });
  assert.deepEqual(check(mixed).blocked.map((value) => value.name), ["fdir", "tinyglobby"]);
  for (const reference of ["missing", "tinyglobby", "toString"]) {
    const value = report();
    value.vulnerabilities.fdir.via.push(reference);
    assert.throws(() => check(value), /Unresolved audit cause/);
  }
});

test("invalid report shapes and summaries fail closed", () => {
  const changes = [
    (value) => { value.error = { code: "E500" }; },
    (value) => { value.auditReportVersion = 3; },
    (value) => { value.vulnerabilities = []; },
    (value) => { delete value.metadata; },
    (value) => { value.metadata.vulnerabilities.high = 0; },
    (value) => { value.vulnerabilities.picomatch.name = "other"; },
    (value) => { value.vulnerabilities.picomatch.severity = "unknown"; },
    (value) => { value.vulnerabilities.picomatch.via = []; },
    (value) => { value.vulnerabilities.picomatch.via.push(null); },
    (value) => { value.vulnerabilities.picomatch.via.push({}); },
    (value) => { value.vulnerabilities.picomatch.via[0].source = "1247710"; },
    (value) => { delete value.vulnerabilities.picomatch.nodes; },
  ];
  for (const change of changes) {
    const value = report();
    change(value);
    assert.throws(() => check(value));
  }
  for (const value of [null, [], {}, "", 2]) assert.throws(() => check(value));
});

test("unexpected or contradictory command statuses fail closed", () => {
  for (const status of [null, 2, -1, "1", 0]) {
    assert.throws(() => checkAudit(report(), status, "high", beforeExpiry));
  }
  assert.throws(() => checkAudit(report({}), 1, "high", beforeExpiry));
  assert.throws(() => checkAudit(report(), 1, "unknown", beforeExpiry));
  assert.throws(() => checkAudit(report(), 1, "high", NaN));
});

test("command boundary uses npm JSON and preserves a useful failure output", () => {
  const output = [];
  const errors = [];
  const execute = (command, args) => {
    assert.equal(command, "npm");
    assert.deepEqual(args, ["--prefix", "landing", "audit", "--json", "--audit-level=moderate"]);
    return { status: 1, stdout: JSON.stringify(report({ other: entry("other", [{ ...advisory }]) })) };
  };
  assert.equal(runAudit(["moderate", "landing"], execute, (line) => output.push(line), (line) => errors.push(line)), 1);
  assert.equal(output.length, 0);
  assert.match(errors[0], /blocked \(moderate\+\): other \(high\)/);
  for (const result of [
    { status: 0, stdout: "invalid JSON" }, { status: 2, stdout: "{}" },
    { status: null, signal: "SIGTERM" }, { status: null, error: new Error("command unavailable") },
  ]) {
    errors.length = 0;
    assert.equal(runAudit(["high"], () => result, () => {}, (line) => errors.push(line)), 1);
    assert.match(errors[0], /Dependency audit failed:/);
  }
  assert.equal(runAudit(["high"], () => ({ status: 0, stdout: JSON.stringify(report({})) }), () => {}, () => {}), 0);
  assert.equal(runAudit(["high", "unexpected"], () => assert.fail("must not execute"), () => {}, () => {}), 1);
});
