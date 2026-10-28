import { describe, expect, it } from "vitest";
import { fmtDate, localTime } from "./format";

describe("absolute timestamps", () => {
  it.each(["UTC", "America/New_York", "Asia/Kolkata"])("labels the server fallback as UTC under %s", (zone) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      expect(fmtDate(new Date("2027-01-22T18:45:00Z"))).toBe("22 Jan 2027, 18:45 UTC");
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });

  it("keeps the instant in a machine-readable time with a UTC fallback", async () => {
    expect(String(await localTime(new Date("2027-01-22T18:45:00Z")))).toBe('<time datetime="2027-01-22T18:45:00.000Z" data-local-time>22 Jan 2027, 18:45 UTC</time>');
  });
});
