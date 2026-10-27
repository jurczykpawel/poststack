import { describe, expect, it, vi, afterEach } from "vitest";
import { parseScheduledAt, PAST_SKEW_MS } from "./schedule";

afterEach(() => vi.useRealTimers());
describe("delivery schedule", () => {
  it.each(["", "bad-date", "2025-01-01T00:00:00Z"])("rejects invalid or past date %s", (value) => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-27T12:00:00Z"));
    expect(() => parseScheduledAt(value)).toThrow();
  });
  it("uses the creation skew boundary and accepts future instants with offsets", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-27T12:00:00Z"));
    expect(parseScheduledAt(new Date(Date.now() - PAST_SKEW_MS).toISOString()).getTime()).toBe(Date.now() - PAST_SKEW_MS);
    expect(() => parseScheduledAt(new Date(Date.now() - PAST_SKEW_MS - 1).toISOString())).toThrow();
    expect(parseScheduledAt("2026-10-28T14:00:00+02:00").toISOString()).toBe("2026-10-28T12:00:00.000Z");
  });
});
