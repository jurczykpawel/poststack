import { ApiError } from "@/lib/api/response";

export const PAST_SKEW_MS = 5 * 60_000;

export const SCHEDULE_HORIZON_DAYS = 3650;

export function parseScheduledAt(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApiError("invalid_request", "Invalid scheduledAt", 422);
  const now = Date.now();
  if (date.getTime() > now + SCHEDULE_HORIZON_DAYS * 86_400_000) {
    throw new ApiError("invalid_request", `scheduledAt is too far in the future (maximum ${SCHEDULE_HORIZON_DAYS} days)`, 422);
  }
  if (date.getTime() < now - PAST_SKEW_MS) throw new ApiError("invalid_request", "scheduledAt is in the past", 422);
  return date;
}
