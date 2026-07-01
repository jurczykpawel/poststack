import { encryptString, decryptString } from "@/lib/crypto";

/** Custom HTTP header name → value, as entered by the operator. */
export type HeaderMap = Record<string, string>;

/** Encrypt a header map for storage. Empty/undefined map -> null (no headers configured). */
export function encryptHeaderMap(map: HeaderMap | undefined): string | null {
  if (!map || Object.keys(map).length === 0) return null;
  return encryptString(JSON.stringify(map));
}

/** Decrypt stored header text back into a map. Null/garbage -> {} (never throws into a send path). */
export function decryptHeaderMap(stored: string | null): HeaderMap {
  if (!stored) return {};
  try {
    return JSON.parse(decryptString(stored)) as HeaderMap;
  } catch {
    return {};
  }
}

/** Parse a `Key: Value` per-line textarea into a header map (ignoring blanks / malformed lines). */
export function parseHeaderLines(raw: string): HeaderMap {
  const out: HeaderMap = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}
