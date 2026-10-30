import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Probe local bytes only; an unreadable video keeps its duration unknown. */
export async function videoDuration(bytes: Uint8Array | string): Promise<number | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "poststack-probe-"));
  try {
    const file = typeof bytes === "string" ? bytes : join(directory, "video");
    if (typeof bytes !== "string") await writeFile(file, bytes);
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { timeout: 10_000, maxBuffer: 16 * 1024 });
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 && seconds <= 2147483647 ? Math.ceil(seconds) : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
