import { ApiError } from "@/lib/api/response";
import { encryptString, decryptString } from "@/lib/crypto";

/** Custom HTTP header name → value, as entered by the operator. */
export type HeaderMap = Record<string, string>;

/** Validate custom headers before storing them for HTTP delivery. */
export function assertValidHeaderMap(map: HeaderMap | undefined): void {
  for (const [name, value] of Object.entries(map ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.length > 200) {
      throw new ApiError("invalid_request", "Custom header names must be valid HTTP header names (maximum 200 characters).", 422);
    }
    if (value.length > 4000 || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new ApiError("invalid_request", "Custom header values must contain no control characters (maximum 4000 characters).", 422);
    }
    try {
      new Headers({ [name]: value });
    } catch {
      throw new ApiError("invalid_request", "Custom header values must be valid HTTP header values.", 422);
    }
  }
}

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
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    if ([...line].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new ApiError("invalid_request", "Custom header lines must contain no control characters.", 422);
    }
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key) out[key] = val;
  }
  assertValidHeaderMap(out);
  return out;
}
