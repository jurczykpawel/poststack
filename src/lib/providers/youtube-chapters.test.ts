import { describe, it, expect } from "vitest";
import { youtubeChaptersSchema, appendChapters } from "./youtube-chapters";

// Receiver contract (YouTube Help 9884579): the list starts at 0:00, has at least 3 timestamps in
// ascending order and every chapter lasts at least 10 seconds. This parser reads a finished
// description the way YouTube does, independently of how appendChapters builds it.
function youtubeSeesChapters(description: string): { start: number; title: string }[] | null {
  const found = [...description.matchAll(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/gm)].map((m) => ({
    start: m[1]!.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0),
    title: m[2]!,
  }));
  const ok = found.length >= 3 && found[0]!.start === 0 && found.every((c, i) => i === 0 || c.start - found[i - 1]!.start >= 10);
  return ok ? found : null;
}

const good = [
  { start: "00:00", title: "Intro" },
  { start: "1:05", title: "Setup" },
  { start: 3725, title: "Wrap-up" },
];

describe("youtubeChaptersSchema", () => {
  it("accepts clock strings and plain seconds, normalising to seconds", () => {
    const parsed = youtubeChaptersSchema.parse(good);
    expect(parsed).toEqual([
      { start: 0, title: "Intro" },
      { start: 65, title: "Setup" },
      { start: 3725, title: "Wrap-up" },
    ]);
  });

  it.each([
    ["fewer than 3 chapters", good.slice(0, 2)],
    ["first chapter not at 00:00", [{ start: "00:05", title: "a" }, { start: "00:20", title: "b" }, { start: "00:40", title: "c" }]],
    ["not ascending", [good[0], { start: "02:00", title: "b" }, { start: "01:00", title: "c" }]],
    ["duplicate start", [good[0], { start: "01:00", title: "b" }, { start: "01:00", title: "c" }]],
    ["shorter than 10 seconds", [good[0], { start: "00:09", title: "b" }, { start: "01:00", title: "c" }]],
    ["empty title", [good[0], { start: "01:00", title: "  " }, { start: "02:00", title: "c" }]],
    ["angle brackets in title", [good[0], { start: "01:00", title: "<b>" }, { start: "02:00", title: "c" }]],
    ["malformed time", [good[0], { start: "1:5", title: "b" }, { start: "02:00", title: "c" }]],
  ])("rejects %s", (_n, chapters) => {
    expect(youtubeChaptersSchema.safeParse(chapters).success).toBe(false);
  });

  it("reports a readable reason", () => {
    const r = youtubeChaptersSchema.safeParse(good.slice(0, 2));
    expect(r.success ? "" : r.error.issues[0]!.message).toMatch(/at least 3/);
  });
});

describe("appendChapters", () => {
  const chapters = youtubeChaptersSchema.parse(good);

  it("produces a description that YouTube turns into chapters", () => {
    const out = appendChapters("My video", chapters);
    expect(youtubeSeesChapters(out)).toEqual([
      { start: 0, title: "Intro" },
      { start: 65, title: "Setup" },
      { start: 3725, title: "Wrap-up" },
    ]);
    expect(out.startsWith("My video\n\n")).toBe(true);
  });

  it("works for an empty caption", () => {
    expect(youtubeSeesChapters(appendChapters("", chapters))).not.toBeNull();
  });

  it("leaves the caption alone without chapters, so pasted chapters stay as they are", () => {
    const pasted = "Hi\n\n00:00 A\n00:30 B\n01:00 C";
    expect(appendChapters(pasted, null)).toBe(pasted);
    expect(appendChapters(pasted, undefined)).toBe(pasted);
    expect(appendChapters(pasted, [])).toBe(pasted);
  });
});
