import type { ZodError } from "zod";

export type ApiResponse<T> =
  | { data: T; error: null; meta?: Record<string, unknown> }
  | { data: null; error: { code: string; message: string; details?: unknown }; meta?: never };

export interface Detail {
  path: string;
  message: string;
}

/**
 * A throwable API error (ported from PostStack). Service-layer code throws this; the central
 * onError handler converts it to the `{ data, error }` envelope via `apiErrorResponse`. Keeps
 * services free of Response plumbing while preserving the unified envelope shape.
 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: Detail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Map a ZodError to field-level details for a 422 body. */
export function zodDetails(e: ZodError): Detail[] {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/**
 * Validate an optional enum-typed query param against its allow-list. A bogus value would otherwise
 * flow into a Postgres enum column and raise a masked 500. Returns the narrowed value (or undefined)
 * or throws 422 (PSA56).
 */
export function validateEnumParam<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ApiError("invalid_request", `Invalid ${field}`, 422, [
      { path: field, message: `must be one of: ${allowed.join(", ")}` },
    ]);
  }
  return value as T;
}

/** Convert a thrown ApiError into the unified `{ data, error }` Response envelope. */
export function apiErrorResponse(e: ApiError): Response {
  return err(e.code, e.message, e.status, e.details && e.details.length ? e.details : undefined);
}

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
};

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200): Response {
  return Response.json({ data, error: null, ...(meta ? { meta } : {}) }, { status });
}

export function created<T>(data: T): Response {
  return ok(data, undefined, 201);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function err(code: string, message: string, status: number, details?: unknown): Response {
  return Response.json(
    { data: null, error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

// Convenience error constructors
export const ApiErrors = {
  unauthorized: (msg = "Authentication required") =>
    err("UNAUTHORIZED", msg, 401),

  forbidden: (msg = "Access denied") =>
    err("FORBIDDEN", msg, 403),

  notFound: (resource = "Resource") =>
    err("NOT_FOUND", `${resource} not found`, 404),

  conflict: (msg: string) =>
    err("CONFLICT", msg, 409),

  badRequest: (msg: string, details?: unknown) =>
    err("BAD_REQUEST", msg, 400, details),

  validationError: (details: unknown) =>
    err("VALIDATION_ERROR", "Invalid request data", 422, details),

  tooManyRequests: (msg = "Rate limit exceeded") =>
    err("TOO_MANY_REQUESTS", msg, 429),

  // 402: a valid PRO license is required to use this feature.
  proRequired: (feature: string, upgradeUrl: string, msg = "This feature requires a PRO license") =>
    err("PRO_REQUIRED", msg, 402, { feature, upgrade_url: upgradeUrl }),

  internal: (msg = "Internal server error") =>
    err("INTERNAL_ERROR", msg, 500),
};
