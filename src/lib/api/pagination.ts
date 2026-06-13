export interface Cursor {
  createdAt: string; // ISO timestamp
  id: string;
}

/** Opaque, URL-safe base64 of the tuple. Not encrypted — just non-plaintext + validated. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), "utf8").toString("base64url");
}

/** Decode + validate. Returns null on anything malformed (never throws). */
export function decodeCursor(token: string): Cursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      !Number.isNaN(Date.parse(parsed[0]))
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}
