import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Probe local bytes only; unreadable metadata stays unknown. */
export async function videoMetadata(bytes: Uint8Array | string): Promise<{ durationSec?: number; width?: number; height?: number }> {
  const directory = await mkdtemp(join(tmpdir(), "poststack-probe-"));
  try {
    const file = typeof bytes === "string" ? bytes : join(directory, "video");
    if (typeof bytes !== "string") await writeFile(file, bytes);
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=width,height",
      "-of", "json", "-select_streams", "v:0", file,
    ], { timeout: 10_000, maxBuffer: 16 * 1024 });
    const metadata = JSON.parse(stdout);
    const seconds = Number(metadata.format?.duration);
    const stream = metadata.streams?.[0];
    return {
      durationSec: Number.isFinite(seconds) && seconds > 0 && seconds <= 2147483647 ? Math.ceil(seconds) : undefined,
      width: stream?.width, height: stream?.height,
    };
  } catch {
    return {};
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
