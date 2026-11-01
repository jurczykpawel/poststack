import { z } from "zod";

export type YouTubeChapter = { start: number; title: string };

const CLOCK = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

// "00:00" / "1:05" / "1:02:05" or plain seconds → seconds.
const start = z.union([z.number().int().min(0).max(86399), z.string().regex(CLOCK, "start must look like 00:00 or 1:02:03")])
  .transform((v) => {
    if (typeof v === "number") return v;
    const [, h, m, s] = CLOCK.exec(v)!;
    return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
  });

const title = z.string().trim().min(1).max(100).regex(/^[^<>\r\n]+$/, "title must not contain < > or line breaks");

/**
 * YouTube has no chapters field: it builds them from timestamps in the description, and only when the
 * list starts at 00:00, has at least 3 entries, ascends, and every chapter lasts 10 s or more.
 */
export const youtubeChaptersSchema = z
  .array(z.object({ start, title }))
  .max(100)
  .superRefine((chapters, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (chapters.length < 3) return fail("YouTube needs at least 3 chapters");
    if (chapters[0]!.start !== 0) return fail("the first chapter must start at 00:00");
    chapters.forEach((c, i) => {
      if (i > 0 && c.start - chapters[i - 1]!.start < 10) fail(`chapter ${i + 1} must start at least 10 seconds after the previous one`);
    });
  });

function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Appends the chapter list to the description; with no chapters the description is untouched. */
export function appendChapters(caption: string, chapters: YouTubeChapter[] | null | undefined): string {
  if (!chapters?.length) return caption;
  const block = chapters.map((c) => `${clock(c.start)} ${c.title}`).join("\n");
  return caption ? `${caption}\n\n${block}` : block;
}
