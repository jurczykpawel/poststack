import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function convert(local: string, zone = "Europe/Warsaw") {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    const context = {
      window: {} as { psScheduleTime?: (s: string) => { iso: string; notice: string } }, Date, Intl,
      document: { readyState: "loading", addEventListener() {} },
    };
    runInNewContext(readFileSync("src/server/ui/static/schedule-time.js", "utf8"), context);
    return context.window.psScheduleTime!(local);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
}

describe("local schedule conversion", () => {
  it("warns before shifting a nonexistent spring time", () => {
    expect(convert("2027-03-28T02:30")).toEqual({ iso: "2027-03-28T01:30:00.000Z", notice: expect.stringMatching(/does not exist.*03:30.*UTC\+02:00/) });
  });
  it("explains which occurrence of a repeated autumn time is selected", () => {
    expect(convert("2027-10-31T02:30")).toEqual({ iso: "2027-10-31T00:30:00.000Z", notice: expect.stringMatching(/occurs twice.*earlier.*UTC\+02:00/) });
  });
  it("supports half-hour daylight saving changes", () => {
    expect(convert("2027-04-04T01:45", "Australia/Lord_Howe").notice).toMatch(/occurs twice.*UTC\+11:00/);
    expect(convert("2027-10-03T02:15", "Australia/Lord_Howe").notice).toMatch(/does not exist.*02:45/);
  });
  it("leaves ordinary and UTC times without a warning", () => {
    expect(convert("2027-01-10T12:30")).toEqual({ iso: "2027-01-10T11:30:00.000Z", notice: "" });
    expect(convert("2027-03-28T02:30", "UTC")).toEqual({ iso: "2027-03-28T02:30:00.000Z", notice: "" });
  });
  it("handles empty and invalid input without throwing", () => {
    expect(convert("")).toEqual({ iso: "", notice: "" });
    expect(convert("invalid")).toEqual({ iso: "", notice: "" });
  });
});

describe("local timestamp display", () => {
  it("refreshes the main fragment when learning a calendar view's zone", async () => {
    const ajax = vi.fn(() => Promise.resolve());
    const reload = vi.fn();
    const marker = { inert: false, getAttribute: () => "Other/Zone", setAttribute: () => {} };
    runInNewContext(readFileSync("src/server/ui/static/schedule-time.js", "utf8"), {
      window: { htmx: { ajax } }, Date, Intl, Number,
      location: { href: "http://localhost/overview", reload },
      document: { readyState: "complete", cookie: "", querySelectorAll: () => [], querySelector: () => marker,
        getElementById: (id: string) => id === "main" ? {} : null, addEventListener: () => {} },
    });
    expect(marker.inert).toBe(true);
    await Promise.resolve();
    expect(marker.inert).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(ajax).toHaveBeenCalledWith("GET", "http://localhost/overview", { target: "#main", select: "#main", swap: "outerHTML" });
  });
  it.each(["Europe/Warsaw", "Pacific/Auckland"])("uses one local clock for message times and tooltips in %s", (zone) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      const clock = { textContent: "", getAttribute: (name: string) => name === "datetime" ? "2026-10-26T18:00:00Z" : "clock" };
      const email = { textContent: "", getAttribute: (name: string) => name === "datetime" ? "2026-10-26T18:00:00Z" : "email" };
      const tooltip = { title: "", getAttribute: () => "2026-10-26T18:00:00Z" };
      runInNewContext(readFileSync("src/server/ui/static/schedule-time.js", "utf8"), {
        window: {}, Date, Intl, Number,
        document: { readyState: "complete", cookie: "ps_tz=" + encodeURIComponent(zone), addEventListener: () => {},
          querySelectorAll: (selector: string) => selector.startsWith("time") ? [clock, email] : [tooltip] },
      });
      expect(clock.textContent).toBe(zone === "Europe/Warsaw" ? "19:00" : "07:00");
      expect(tooltip.title).toContain(zone === "Europe/Warsaw" ? "26 Oct 2026, 19:00" : "27 Oct 2026, 07:00");
      expect(tooltip.title).toContain(zone);
      expect(email.textContent).toBe(zone === "Europe/Warsaw" ? "26 Oct, 19:00" : "27 Oct, 07:00");
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });
  it.each([
    ["America/New_York", "2027-12-22T15:30:00Z", "22 Dec 2027, 10:30"],
    ["Asia/Kolkata", "2027-01-22T18:45:00Z", "23 Jan 2027, 00:15"],
  ])("localizes initial and swapped timestamps in %s", (zone, iso, text) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      const listeners = new Map<string, (e: { target: unknown }) => void>();
      const element = { textContent: "UTC fallback", getAttribute: () => iso };
      const root = { querySelectorAll: () => [element] };
      runInNewContext(readFileSync("src/server/ui/static/schedule-time.js", "utf8"), {
        window: {}, Date, Intl, Number,
        document: { readyState: "loading", ...root, addEventListener: (name: string, fn: (e: { target: unknown }) => void) => listeners.set(name, fn) },
      });
      listeners.get("DOMContentLoaded")?.({ target: root });
      expect(element.textContent).toBe(`${text} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
      element.textContent = "UTC fallback";
      listeners.get("htmx:load")?.({ target: root });
      expect(element.textContent).toBe(`${text} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });
});
