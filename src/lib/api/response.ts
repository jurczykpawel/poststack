export type ApiResponse<T> =
  | { data: T; error: null; meta?: Record<string, unknown> }
  | { data: null; error: { code: string; message: string; details?: unknown }; meta?: never };

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

  internal: (msg = "Internal server error") =>
    err("INTERNAL_ERROR", msg, 500),
};
