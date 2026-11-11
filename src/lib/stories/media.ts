import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { AutoStoryMode } from "@/db/schema";
import type { PublishRequest } from "@/lib/providers/types";
import { getMedia } from "@/lib/media/service";
import { safeFetch } from "@/lib/media/ssrf";
import { ApiError } from "@/lib/api/response";
import { readBodyCapped } from "@/lib/media/read-capped";
import { downloadToFile, instagramStoryClips, SPLIT_SOURCE_MAX_BYTES, storyClipCuts } from "./segments";

const run = promisify(execFile);
export const resolveAutoStoryMode = (post?: AutoStoryMode | null, channel?: AutoStoryMode | null): AutoStoryMode => post ?? channel ?? "card";
/** Facebook Story video length accepted and shown in full (measured 2026-11-10: 120 s); longer falls back to the card. */
export const FB_STORY_MAX_SEC = 120;
const STORY_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** One or more Story media URLs (a long Instagram video becomes consecutive clips), or a card fallback. */
interface StoryMedia { mediaUrls?: string[]; mediaKind?: "image" | "video"; thumbnail?: Uint8Array; fallbackReason?: string }

const FALLBACK_TEXT: Record<string, string> = {
  missing_media: "the post has no ready media",
  media_unreadable: "the media could not be read",
  media_size: "the file is too large",
  image_size: "the image is too large",
  image_format: "the image format is not supported",
  video_duration: `the video is shorter than 3 s or longer than Facebook's ${FB_STORY_MAX_SEC} s`,
  video_format: "the video must be MP4/MOV, H.264/HEVC, yuv420p",
  video_audio: "the audio must be AAC up to 48 kHz, mono or stereo",
  video_frame_rate: "the frame rate is outside the Story limits",
  video_dimensions: "the video dimensions are outside the Story limits",
};
/** Human-readable reason an auto-Story in `media` mode was sent as the generated card. */
export const storyFallbackText = (reason: string): string => `Story sent as a card: ${FALLBACK_TEXT[reason] ?? reason}.`;

/** `clipKey`: storage prefix for the clips of a long Instagram video (deterministic per delivery). */
export async function prepareStoryMedia(request: PublishRequest, workspaceId: string, platform: string, mode: AutoStoryMode, clipKey: string): Promise<StoryMedia> {
  const fallback = (reason: string, thumbnail?: Uint8Array): StoryMedia => ({ thumbnail, ...(mode === "media" ? { fallbackReason: reason } : {}) });
  const first = request.media[0];
  const asset = first && await getMedia(first.mediaId, workspaceId).catch(() => undefined);
  if (!asset || asset.status !== "ready") return fallback("missing_media");
  try {
    if (asset.kind === "image") {
      const response = await safeFetch(asset.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { await response.body?.cancel(); return fallback("media_unreadable"); }
      const bytes = await readBodyCapped(response, 16 * 1024 * 1024);
      if (mode === "media" && bytes.byteLength > (platform === "instagram" ? 8 : 10) * 1024 * 1024) return fallback("image_size", bytes);
      const image = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      const formats = platform === "instagram" ? ["jpeg"] : ["jpeg", "png", "gif", "tiff", "bmp"];
      if (!formats.includes(image.format ?? "")) return fallback("image_format", bytes);
      return mode === "media" ? { mediaUrls: [asset.url], mediaKind: "image" } : { thumbnail: bytes };
    }
    const directory = await mkdtemp(join(tmpdir(), "poststack-story-"));
    try {
      const file = join(directory, "video");
      const split = mode === "media" && platform === "instagram";
      await downloadToFile(asset.url, file, split ? SPLIT_SOURCE_MAX_BYTES : STORY_VIDEO_MAX_BYTES);
      const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,sample_rate,channels", "-of", "json", file], { timeout: 10_000, maxBuffer: 16 * 1024 });
      const probe = JSON.parse(stdout);
      const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
      const audio = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "audio");
      const duration = Number(probe.format?.duration) || (asset.duration_sec ?? 0);
      const [n, d] = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
      const fps = n! / d!;
      let reason: string | undefined;
      if (!(duration >= 3 && (platform !== "facebook" || duration <= FB_STORY_MAX_SEC))) reason = "video_duration";
      else if (!/(^|,)(mp4|mov)(,|$)/.test(probe.format?.format_name ?? "") || !["h264", "hevc"].includes(video?.codec_name) || video?.pix_fmt !== "yuv420p") reason = "video_format";
      else if (audio && (audio.codec_name !== "aac" || !(Number(audio.sample_rate) <= 48000) || ![1, 2].includes(audio.channels))) reason = "video_audio";
      else if (!(fps >= (platform === "facebook" ? 24 : 23) && fps <= 60)) reason = "video_frame_rate";
      else if (platform === "facebook" ? !(video.width >= 540 && video.height >= 960 && video.width * 16 === video.height * 9) : !(video.width <= 1920 && video.width / video.height >= 0.1 && video.width / video.height <= 10)) reason = "video_dimensions";
      if (!reason && !storyClipCuts(duration).length && (await stat(file)).size > STORY_VIDEO_MAX_BYTES) reason = "media_size";
      if (mode === "media" && !reason) return { mediaUrls: split ? await instagramStoryClips(file, duration, asset.url, clipKey) : [asset.url], mediaKind: "video" };
      const frame = await run("ffmpeg", ["-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "1", "-i", file, "-frames:v", "1", "-vf", "scale=540:960:force_original_aspect_ratio=decrease", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "buffer" }).catch(() => undefined);
      return fallback(reason ?? "media_unreadable", frame?.stdout);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } catch (error) { return fallback(error instanceof ApiError && error.code === "too_large" ? "media_size" : "media_unreadable"); }
}
