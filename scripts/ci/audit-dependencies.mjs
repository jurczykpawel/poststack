import console from "node:console";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const levels = ["info", "low", "moderate", "high", "critical"];
const exceptionUrl = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const expiry = "2026-11-25T00:00:00Z";
const expiresAt = Date.parse(expiry);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const validLevel = (value) => levels.includes(value);

export function checkAudit(report, status, threshold, now = Date.now()) {
  if (![0, 1].includes(status) || !validLevel(threshold) || !Number.isFinite(now)) {
    throw new Error("Invalid audit status, threshold, or clock");
  }
  if (!object(report) || Object.hasOwn(report, "error") || report.auditReportVersion !== 2 ||
      !object(report.vulnerabilities) || !object(report.metadata?.vulnerabilities)) {
    throw new Error("Unsupported audit report");
  }
  const entries = report.vulnerabilities;
  const counts = Object.fromEntries(levels.map((level) => [level, 0]));
  for (const [name, entry] of Object.entries(entries)) {
    if (!name || !object(entry) || entry.name !== name || !validLevel(entry.severity) ||
        typeof entry.isDirect !== "boolean" || typeof entry.range !== "string" ||
        !strings(entry.nodes) || entry.nodes.length === 0 || !strings(entry.effects) ||
        !Array.isArray(entry.via) || entry.via.length === 0 ||
        !(typeof entry.fixAvailable === "boolean" || (object(entry.fixAvailable) &&
          typeof entry.fixAvailable.name === "string" && typeof entry.fixAvailable.version === "string" &&
          typeof entry.fixAvailable.isSemVerMajor === "boolean"))) {
      throw new Error(`Invalid audit entry: ${name}`);
    }
    counts[entry.severity]++;
  }
  const summary = report.metadata.vulnerabilities;
  if (levels.some((level) => summary[level] !== counts[level]) ||
      summary.total !== Object.keys(entries).length) {
    throw new Error("Audit summary does not match entries");
  }
  const aboveThreshold = (entry) => levels.indexOf(entry.severity) >= levels.indexOf(threshold);
  if (status !== Number(Object.values(entries).some(aboveThreshold))) {
    throw new Error("Audit exit status does not match report");
  }
  const accepted = new Map();
  const visiting = new Set();
  function accepts(name) {
    if (!Object.hasOwn(entries, name) || visiting.has(name)) {
      throw new Error(`Unresolved audit cause: ${name}`);
    }
    if (accepted.has(name)) return accepted.get(name);
    visiting.add(name);
    const entry = entries[name];
    const causes = entry.via.map((cause) => {
      if (typeof cause === "string") return accepts(cause);
      if (!object(cause) || !Number.isInteger(cause.source) || cause.source <= 0 ||
          typeof cause.name !== "string" || !cause.name ||
          typeof cause.dependency !== "string" || !cause.dependency ||
          typeof cause.url !== "string" || !cause.url || !validLevel(cause.severity) ||
          typeof cause.range !== "string") {
        throw new Error(`Invalid audit cause: ${name}`);
      }
      return name === "picomatch" && entry.severity === "high" && cause.name === "picomatch" &&
        cause.dependency === "picomatch" && cause.severity === "high" &&
        cause.url === exceptionUrl && now < expiresAt;
    });
    visiting.delete(name);
    const result = entry.severity === "high" && causes.every(Boolean);
    accepted.set(name, result);
    return result;
  }
  for (const name of Object.keys(entries)) accepts(name);
  return {
    blocked: Object.values(entries).filter((entry) => aboveThreshold(entry) && !accepted.get(entry.name)),
    accepted: [...accepted.values()].filter(Boolean).length,
  };
}

export function runAudit(args, execute = spawnSync, log = console.log, error = console.error) {
  try {
    const [threshold, prefix] = args;
    if (args.length > 2 || !["high", "moderate"].includes(threshold) ||
        (prefix !== undefined && prefix !== "landing")) {
      throw new Error("Usage: node scripts/ci/audit-dependencies.mjs <high|moderate> [landing]");
    }
    const command = [...(prefix ? ["--prefix", prefix] : []), "audit", "--json", `--audit-level=${threshold}`];
    const result = execute("npm", command, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.error || result.signal || ![0, 1].includes(result.status)) {
      throw new Error(`npm audit failed: ${result.error?.message || result.signal || result.status}`);
    }
    const verdict = checkAudit(JSON.parse(result.stdout), result.status, threshold);
    if (verdict.blocked.length) {
      error(`Dependency audit blocked (${threshold}+): ${verdict.blocked.map((entry) => `${entry.name} (${entry.severity})`).join(", ")}`);
      return 1;
    }
    log(verdict.accepted > 0
      ? `Dependency audit passed (${threshold}+); temporary exception covers ${verdict.accepted} entries until ${expiry}.`
      : `Dependency audit passed (${threshold}+).`);
    return 0;
  } catch (cause) {
    error(`Dependency audit failed: ${cause.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAudit(process.argv.slice(2));
}
