import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { defaultProbe } from "./probe";

describe("video duration probing", () => {
  it("reads and rounds up duration from the original video bytes", async () => {
    const bytes = await readFile(new URL("../../../tests/fixtures/duration.mp4", import.meta.url));
    const original = Buffer.from(bytes);
    expect(await defaultProbe(bytes, "video/mp4")).toMatchObject({ kind: "video", mime: "video/mp4", durationSec: 1 });
    expect(bytes).toEqual(original);
  });
  it("leaves duration unavailable for an incomplete video", async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
    expect((await defaultProbe(bytes, "video/mp4")).durationSec).toBeUndefined();
  });
});
