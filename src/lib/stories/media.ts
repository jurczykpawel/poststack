import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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

const run = promisify(execFile);
export const resolveAutoStoryMode = (post?: AutoStoryMode | null, channel?: AutoStoryMode | null): AutoStoryMode => post ?? channel ?? "card";
interface StoryMedia { mediaUrl?: string; mediaKind?: "image" | "video"; thumbnail?: Uint8Array; fallbackReason?: string }

export async function prepareStoryMedia(request: PublishRequest, workspaceId: string, platform: string, mode: AutoStoryMode): Promise<StoryMedia> {
  const fallback = (reason: string, thumbnail?: Uint8Array): StoryMedia => ({ thumbnail, ...(mode === "media" ? { fallbackReason: reason } : {}) });
  const first = request.media[0];
  const asset = first && await getMedia(first.mediaId, workspaceId).catch(() => undefined);
  if (!asset || asset.status !== "ready") return fallback("missing_media");
  try {
    const cap = (asset.kind === "video" ? 100 : 16) * 1024 * 1024;
    const response = await safeFetch(asset.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { await response.body?.cancel(); return fallback("media_unreadable"); }
    const bytes = await readBodyCapped(response, cap);
    if (asset.kind === "image") {
      if (mode === "media" && bytes.byteLength > (platform === "instagram" ? 8 : 10) * 1024 * 1024) return fallback("image_size", bytes);
      const image = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      const formats = platform === "instagram" ? ["jpeg"] : ["jpeg", "png", "gif", "tiff", "bmp"];
      if (!formats.includes(image.format ?? "")) return fallback("image_format", bytes);
      return mode === "media" ? { mediaUrl: asset.url, mediaKind: "image" } : { thumbnail: bytes };
    }
    const directory = await mkdtemp(join(tmpdir(), "poststack-story-"));
    try {
      const file = join(directory, "video");
      await writeFile(file, bytes);
      const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,sample_rate,channels", "-of", "json", file], { timeout: 10_000, maxBuffer: 16 * 1024 });
      const probe = JSON.parse(stdout);
      const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
      const audio = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === "audio");
      const duration = Math.max(Number(probe.format?.duration), asset.duration_sec ?? 0);
      const [n, d] = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
      const fps = n! / d!;
      let reason: string | undefined;
      if (!(duration >= 3 && duration <= (platform === "facebook" ? 90 : 60))) reason = "video_duration";
      else if (!/(^|,)(mp4|mov)(,|$)/.test(probe.format?.format_name ?? "") || !["h264", "hevc"].includes(video?.codec_name) || video?.pix_fmt !== "yuv420p") reason = "video_format";
      else if (audio && (audio.codec_name !== "aac" || !(Number(audio.sample_rate) <= 48000) || ![1, 2].includes(audio.channels))) reason = "video_audio";
      else if (!(fps >= (platform === "facebook" ? 24 : 23) && fps <= 60)) reason = "video_frame_rate";
      else if (platform === "facebook" ? !(video.width >= 540 && video.height >= 960 && video.width * 16 === video.height * 9) : !(video.width <= 1920 && video.width / video.height >= 0.1 && video.width / video.height <= 10)) reason = "video_dimensions";
      if (mode === "media" && !reason) return { mediaUrl: asset.url, mediaKind: "video" };
      const frame = await run("ffmpeg", ["-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "1", "-i", file, "-frames:v", "1", "-vf", "scale=540:960:force_original_aspect_ratio=decrease", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "buffer" }).catch(() => undefined);
      return fallback(reason ?? "media_unreadable", frame?.stdout);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } catch (error) { return fallback(error instanceof ApiError && error.code === "too_large" ? "media_size" : "media_unreadable"); }
}
