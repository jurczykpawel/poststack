import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { postCreate } from "@/lib/content/schemas";

type Panel = {
  chapters: { start: string; title: string }[]; language: string; tags: string; kids: string;
  localizations: { lang: string; title: string; description: string }[];
  chapterError: string; localizationError: string; tagsError: string; valid(requireKids: boolean): boolean; options(): Record<string, unknown>;
  sortChapters(): void;
};
const win: { psYouTubePanel?: () => Panel } = {};
runInNewContext(readFileSync(new URL("./youtube-panel.js", import.meta.url), "utf8"), { window: win });
const panel = () => win.psYouTubePanel!();

const row = (start: string, title = "T") => ({ start, title });

describe("Compose YouTube panel", () => {
  // The panel's own check must agree with what the API accepts, otherwise the form lets through a
  // payload the server rejects (or blocks one it would accept).
  it.each([
    [[row("00:00"), row("00:30"), row("01:00")]],
    [[row("0:00"), row("1:00"), row("1:00:00")]],
    [[row("00:00"), row("00:30")]],
    [[row("00:05"), row("00:30"), row("01:00")]],
    [[row("00:00"), row("00:09"), row("01:00")]],
    [[row("00:00"), row("01:00"), row("00:30")]],
    [[row("00:00"), row("1:5"), row("01:00")]],
    [[row("00:00"), row("00:30", ""), row("01:00")]],
    [[row("00:00"), row("00:30", "<b>"), row("01:00")]],
  ])("agrees with the API about chapters %j", (chapters) => {
    const p = panel();
    p.chapters = chapters;
    expect(p.chapterError === "").toBe(postCreate.safeParse({ platform: "youtube", youtubeChapters: chapters }).success);
  });

  it("sorts chapters by time so the list stays ascending", () => {
    const p = panel();
    p.chapters = [row("01:00", "b"), row("00:00", "a")];
    p.sortChapters();
    expect(p.chapters.map((c) => c.title)).toEqual(["a", "b"]);
  });

  it("requires a made-for-kids answer only when publishing, and never defaults it", () => {
    const p = panel();
    expect(p.options()).not.toHaveProperty("youtubeMadeForKids");
    expect(p.valid(true)).toBe(false);
    expect(p.valid(false)).toBe(true);
    p.kids = "no";
    expect(p.valid(true)).toBe(true);
    expect(p.options()).toMatchObject({ youtubeMadeForKids: false });
  });

  it("needs a video language before translations, and sends a payload the API accepts", () => {
    const p = panel();
    p.localizations = [{ lang: "en", title: "Hello", description: "" }];
    expect(p.localizationError).not.toBe("");
    p.language = "pl";
    expect(p.localizationError).toBe("");
    p.chapters = [row("00:00"), row("00:30"), row("01:00")];
    p.tags = "a, b";
    expect(postCreate.safeParse({ platform: "youtube", ...JSON.parse(JSON.stringify(p.options())) }).success).toBe(true);
    expect(p.options()).toMatchObject({ youtubeDefaultLanguage: "pl", youtubeTags: ["a", "b"], youtubeLocalizations: { en: { title: "Hello" } } });
  });
});
