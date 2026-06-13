import { ApiError } from "@/lib/api/response";
import { LIMITS } from "@/lib/api/limits";

/** Read + length-cap the Idempotency-Key header (a btree UNIQUE column). Over the limit → 422. */
export function readIdempotencyKey(request: Request): string | undefined {
  const v = request.headers.get("Idempotency-Key") ?? undefined;
  if (v && v.length > LIMITS.ref) {
    throw new ApiError("invalid_request", `Idempotency-Key exceeds ${LIMITS.ref} characters`, 422);
  }
  return v;
}
