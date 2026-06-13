import type { Context } from "hono";
import { ApiError } from "./response";

// PSA7 — input caps. The two btree-indexed UNIQUE columns (idempotency_key, source_ref) MUST stay
// within the index row limit (else Postgres raises "index row size exceeds btree maximum 2704" → 500);
// the rest bound payload/storage bloat. Centralized so every schema references the same numbers.
export const LIMITS = {
  ref: 255, // btree-indexed text: source_ref, idempotency_key, media id, provider account id
  line: 255, // single-line identifiers (platform, language, profile, cta, …)
  name: 500, // titles
  text: 20_000, // long free text (script, description, notes, captions)
  hashtags: 2_000,
  url: 2_000,
  token: 8_000, // long-lived / JWT-ish provider tokens
  arrayLen: 100,
  bodyBytes: 1 * 1024 * 1024, // global JSON request-body cap
} as const;

/** Read + length-cap the Idempotency-Key header (a btree UNIQUE column). Over the limit → 422, never
 *  a leaked 500 from the index write. Header lookup is case-insensitive. */
export function idempotencyKey(c: Context): string | undefined {
  const v = c.req.header("Idempotency-Key");
  if (v && v.length > LIMITS.ref) {
    throw new ApiError("invalid_request", `Idempotency-Key exceeds ${LIMITS.ref} characters`, 422);
  }
  return v;
}
