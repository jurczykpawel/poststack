import { describe, it, expect, afterEach } from "vitest";
import { withIngestSlot, __resetIngestLimit } from "./ingest-limit";
import { ApiError } from "@/lib/api/response";

afterEach(() => {
  __resetIngestLimit();
  delete process.env.MEDIA_INGEST_CONCURRENCY;
  delete process.env.MEDIA_INGEST_QUEUE;
});

describe("withIngestSlot [PSA32]", () => {
  it("never runs more than MEDIA_INGEST_CONCURRENCY ingests at once", async () => {
    process.env.MEDIA_INGEST_CONCURRENCY = "2";
    let concurrent = 0;
    let peak = 0;
    const slow = () =>
      new Promise<void>((res) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        setTimeout(() => {
          concurrent -= 1;
          res();
        }, 25);
      });
    await Promise.all([0, 1, 2, 3, 4].map(() => withIngestSlot(slow)));
    expect(peak).toBe(2);
  });

  it("rejects with 429 when all slots + the queue are full", async () => {
    process.env.MEDIA_INGEST_CONCURRENCY = "1";
    process.env.MEDIA_INGEST_QUEUE = "0";
    __resetIngestLimit();
    let release: () => void = () => {};
    const held = withIngestSlot(() => new Promise<void>((res) => (release = res))); // holds the only slot
    await expect(withIngestSlot(async () => {})).rejects.toBeInstanceOf(ApiError); // no slot, queue full
    release();
    await held;
  });
});
