import { ApiError } from "@/lib/api/response";

export const PAST_SKEW_MS = 5 * 60_000;

export function parseScheduledAt(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApiError("invalid_request", "Invalid scheduledAt", 422);
  if (date.getTime() < Date.now() - PAST_SKEW_MS) throw new ApiError("invalid_request", "scheduledAt is in the past", 422);
  return date;
}
