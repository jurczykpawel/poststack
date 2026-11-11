import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { ApiError } from "@/lib/api/response";
import { safeFetch } from "@/lib/media/ssrf";
import { getStorage } from "@/lib/storage";

const run = promisify(execFile);

/** Instagram Story video, measured 2026-11-10: up to 61.0 s is accepted whole, 61.2 s is rejected. */
export const IG_STORY_WHOLE_MAX_SEC = 61;
/** Longer Instagram Story videos are published as consecutive clips of this length. */
export const STORY_CLIP_SEC = 60;
const STORY_MIN_SEC = 3;
const CLIP_MAX_BYTES = 100 * 1024 * 1024;
/** Source video downloaded for splitting (each clip is checked against the 100 MB Story limit). */
export const SPLIT_SOURCE_MAX_BYTES = 1024 ** 3;

/**
 * Cut points (seconds) for an Instagram Story video; empty = publish whole. Clips are 60 s; a final
 * clip shorter than the 3 s Story minimum cannot be appended (the previous clip would pass the limit)
 * nor dropped (it is the end of the video), so the last 60 s + remainder are split into two equal clips.
 */
export function storyClipCuts(durationSec: number): number[] {
  if (!(durationSec > IG_STORY_WHOLE_MAX_SEC)) return [];
  const cuts: number[] = [];
  for (let at = STORY_CLIP_SEC; at < durationSec; at += STORY_CLIP_SEC) cuts.push(at);
  if (durationSec - cuts.at(-1)! < STORY_MIN_SEC) cuts[cuts.length - 1] = ((cuts.at(-2) ?? 0) + durationSec) / 2;
  return cuts;
}

export const storySegmentCount = (durationSec: number): number => storyClipCuts(durationSec).length + 1;

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 10_000, maxBuffer: 1024 });
  return Number(stdout.trim());
}

/** Stream a remote file to disk with a hard byte cap. */
export async function downloadToFile(url: string, file: string, maxBytes: number): Promise<void> {
  const response = await safeFetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`media download failed (${response.status})`); }
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new ApiError("too_large", "Media exceeds ingest cap", 413); }
  let total = 0;
  const cap = new Transform({ transform(chunk: Buffer, _encoding, done) {
    total += chunk.length;
    done(total > maxBytes ? new ApiError("too_large", "Media exceeds ingest cap", 413) : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), cap, createWriteStream(file));
}

async function segment(file: string, cuts: number[], directory: string, name: string, codec: string[]): Promise<string[]> {
  await run("ffmpeg", ["-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", ...codec,
    "-f", "segment", "-segment_times", cuts.join(","), "-segment_time_delta", "0.05", "-reset_timestamps", "1", "-segment_format_options", "movflags=+faststart", join(directory, `${name}-%03d.mp4`)], { timeout: 900_000 });
  return (await readdir(directory)).filter(f => f.startsWith(`${name}-`)).sort().map(f => join(directory, f));
}

async function clipsFit(clips: string[], count: number): Promise<boolean> {
  if (clips.length !== count) return false;
  for (const clip of clips) {
    const duration = await probeDuration(clip);
    if (!(duration >= STORY_MIN_SEC - 0.1 && duration <= IG_STORY_WHOLE_MAX_SEC) || (await stat(clip)).size > CLIP_MAX_BYTES) return false;
  }
  return true;
}

/** Cut a local video at `cuts` into ordered clips: stream copy first, re-encoded when keyframes miss the cut points. */
export async function cutStoryClips(file: string, cuts: number[], directory: string): Promise<string[]> {
  const copied = await segment(file, cuts, directory, "copy", ["-c", "copy"]);
  if (await clipsFit(copied, cuts.length + 1)) return copied;
  const encoded = await segment(file, cuts, directory, "encoded", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", "8M", "-bufsize", "16M",
    "-pix_fmt", "yuv420p", "-force_key_frames", cuts.join(","), "-c:a", "aac", "-b:a", "128k"]);
  if (!(await clipsFit(encoded, cuts.length + 1))) throw new Error("Story video could not be split into clips");
  return encoded;
}

/**
 * The Instagram Story media for a local video: the source URL when it fits one Story, otherwise
 * uploaded clips under `keyPrefix` (deterministic keys, so a retry overwrites instead of adding).
 */
export async function instagramStoryClips(file: string, durationSec: number, sourceUrl: string, keyPrefix: string): Promise<string[]> {
  const cuts = storyClipCuts(durationSec);
  if (!cuts.length) return [sourceUrl];
  const directory = await mkdtemp(join(tmpdir(), "poststack-clips-"));
  try {
    const storage = getStorage();
    const urls: string[] = [];
    for (const [i, clip] of (await cutStoryClips(file, cuts, directory)).entries()) {
      const key = `${keyPrefix}/clip-${i + 1}.mp4`;
      await storage.putStream(key, createReadStream(clip), "video/mp4");
      urls.push(storage.publicUrl(key));
    }
    return urls;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Download a remote Story video and return its Instagram Story media (see `instagramStoryClips`). */
export async function fetchInstagramStoryClips(sourceUrl: string, keyPrefix: string): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "poststack-story-"));
  try {
    const file = join(directory, "video");
    await downloadToFile(sourceUrl, file, SPLIT_SOURCE_MAX_BYTES);
    return await instagramStoryClips(file, await probeDuration(file), sourceUrl, keyPrefix);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Publish clips in order, skipping those already published (`done`) and saving progress after each. */
export async function publishClips(urls: string[], done: readonly string[], publish: (url: string) => Promise<string>, save: (handles: string[]) => Promise<void>): Promise<string[]> {
  const handles = [...done];
  for (let i = handles.length; i < urls.length; i++) {
    handles.push(await publish(urls[i]!));
    await save([...handles]);
  }
  return handles;
}
