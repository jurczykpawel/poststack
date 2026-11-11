import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutStoryClips, probeDuration, publishClips, storyClipCuts, storySegmentCount } from "./segments";

const lengths = (duration: number) => {
  const cuts = storyClipCuts(duration);
  return [...cuts, duration].map((end, i) => end - (i ? cuts[i - 1]! : 0));
};

describe("Instagram Story clip plan", () => {
  it.each([
    [59, [59]],
    [60, [60]],
    [61, [61]],
    [125, [60, 60, 5]],
    [180, [60, 60, 60]],
  ])("%s s → clips %j", (duration, expected) => {
    expect(lengths(duration)).toEqual(expected);
    expect(storySegmentCount(duration)).toBe(expected.length);
  });
  it.each([[61.5, [30.75, 30.75]], [121, [60, 30.5, 30.5]]])("splits the last minute evenly when a clip would be under 3 s (%s s)", (duration, expected) => {
    expect(lengths(duration)).toEqual(expected);
    expect(storySegmentCount(duration)).toBe(expected.length);
  });
});

describe("cutting clips with ffmpeg", () => {
  let directory: string;
  const source = (name: string, seconds: number, gop: number) => {
    const file = join(directory, `${name}.mp4`);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=180x320:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-g", String(gop), ...(gop < 100 ? ["-force_key_frames", `expr:gte(t,n_forced*${gop / 24})`] : []), "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
    return file;
  };
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "story-clips-")); });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each([["dense keyframes", 48, "copy"], ["one keyframe", 10_000, "encoded"]])("splits a 125 s video into 60/60/5 s clips — %s (GOP %s → %s)", async (_name, gop, path) => {
    const out = mkdtempSync(join(directory, "out-"));
    const clips = await cutStoryClips(source(`v${gop}`, 125, gop), storyClipCuts(125), out);
    const durations = await Promise.all(clips.map(probeDuration));
    expect(durations).toHaveLength(3);
    expect(clips.every(clip => clip.includes(`/${path}-`))).toBe(true);
    durations.forEach((d, i) => expect(d).toBeCloseTo([60, 60, 5][i]!, 0));
    expect(Math.max(...durations)).toBeLessThanOrEqual(61);
  }, 120_000);
});

describe("publishing clips in order", () => {
  const urls = ["u1", "u2", "u3"];
  it("publishes every clip in order and saves progress after each", async () => {
    const publish = vi.fn(async (url: string) => `h-${url}`);
    const save = vi.fn(async () => {});
    expect(await publishClips(urls, [], publish, save)).toEqual(["h-u1", "h-u2", "h-u3"]);
    expect(publish.mock.calls.map(c => c[0])).toEqual(urls);
    expect(save).toHaveBeenLastCalledWith(["h-u1", "h-u2", "h-u3"]);
  });
  it("a retry after a failed clip does not publish the earlier clips again", async () => {
    let saved: string[] = [];
    const save = async (handles: string[]) => { saved = handles; };
    const failing = vi.fn(async (url: string) => { if (url === "u2") throw new Error("boom"); return `h-${url}`; });
    await expect(publishClips(urls, saved, failing, save)).rejects.toThrow("boom");
    expect(saved).toEqual(["h-u1"]);
    const retry = vi.fn(async (url: string) => `h-${url}`);
    expect(await publishClips(urls, saved, retry, save)).toEqual(["h-u1", "h-u2", "h-u3"]);
    expect(retry.mock.calls.map(c => c[0])).toEqual(["u2", "u3"]);
  });
});
