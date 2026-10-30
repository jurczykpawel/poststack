import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeProvider } from "./youtube";
import { tiktokProvider } from "./tiktok";
import { linkedinProvider } from "./linkedin";

vi.mock("@/lib/media/ssrf", () => ({ safeFetch: (url: string, init?: RequestInit) => fetch(url, init) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const MiB = 1024 * 1024;
const source = "https://cdn.example/video.mp4";
const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=example";
const args = { tokens: { accessToken: "test" }, accountId: "123", request: { format: "video", media: [] }, mediaUrls: [source] };
function mediaResponse(init: RequestInit | undefined, size: number): Response {
  if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": String(size) } });
  const range = new Headers(init?.headers).get("range");
  if (!range) throw new Error("Source must be read through bounded ranges");
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range)!;
  const bytes = new Uint8Array(Number(end) - Number(start) + 1).fill(7);
  return new Response(bytes, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(bytes.length) } });
}

describe("documented media transfer contracts", () => {
  // https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
  it("YouTube resumes an interrupted chunk from Google's acknowledged byte, then a fresh job uses the same session", async () => {
    let saved = "", initCount = 0, statusCount = 0, interrupted = false;
    const ranges: string[] = [];
    const size = 33 * MiB;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === source) return mediaResponse(init, size);
      if (init?.method === "POST") { initCount++; return new Response(null, { headers: { location: session } }); }
      expect(init?.redirect).toBe("manual");
      const range = new Headers(init?.headers).get("content-range")!;
      if (range.startsWith("bytes */")) { statusCount++; return new Response(null, { status: 308, headers: { range: `bytes=0-${16 * MiB + 256 * 1024 - 1}` } }); }
      expect(saved).toBe(session);
      ranges.push(range);
      if (ranges.length === 2 && !interrupted) { interrupted = true; throw new Error("connection reset"); }
      if (range.endsWith(`-${size - 1}/${size}`)) return Response.json({ id: "video-once" }, { status: 201 });
      return new Response(null, { status: 308, headers: { range: `bytes=0-${/-(\d+)\//.exec(range)![1]}` } });
    }));
    const first = await youtubeProvider.publish({ ...args, saveUploadSession: async (url) => { saved = url; } });
    expect(first.providerHandle).toBe("video-once");
    expect(ranges).toContain(`bytes ${16 * MiB + 256 * 1024}-${32 * MiB + 256 * 1024 - 1}/${size}`);
    expect(statusCount).toBe(1);
    // A retry after the final response was lost must ask for status, never POST another video.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === source) return mediaResponse(init, size);
      expect(url).toBe(saved);
      expect(new Headers(init?.headers).get("content-range")).toBe(`bytes */${size}`);
      return Response.json({ id: "video-once" }, { status: 201 });
    }));
    expect((await youtubeProvider.publish({ ...args, uploadSession: saved })).providerHandle).toBe("video-once");
    expect(initCount).toBe(1);
  });

  // https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
  it("TikTok uses floor(size/chunk) and merges trailing bytes into the last sequential part", async () => {
    const size = 70 * MiB + 123, ranges: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === source) return mediaResponse(init, size);
      if (url.includes("/init/")) {
        expect(JSON.parse(String(init?.body)).source_info).toEqual({ source: "FILE_UPLOAD", video_size: size, chunk_size: 16 * MiB, total_chunk_count: 4 });
        return Response.json({ data: { publish_id: "v_inbox_file~1", upload_url: "https://upload.us.tiktokapis.com/video/?upload_id=1&upload_token=example" }, error: { code: "ok", message: "", log_id: "example" } });
      }
      ranges.push(new Headers(init?.headers).get("content-range")!);
      return new Response(null, { status: ranges.length === 4 ? 201 : 206 });
    }));
    expect((await tiktokProvider.publish(args)).providerHandle).toBe("v_inbox_file~1");
    expect(ranges).toEqual([`bytes 0-${16 * MiB - 1}/${size}`, `bytes ${16 * MiB}-${32 * MiB - 1}/${size}`, `bytes ${32 * MiB}-${48 * MiB - 1}/${size}`, `bytes ${48 * MiB}-${size - 1}/${size}`]);
  });

  // Documented initializeUpload response: Microsoft Learn /linkedin/.../shares/videos-api
  it("LinkedIn uploads the server's ranges and finalizes ordered ETags before creating the video post", async () => {
    const size = 5 * MiB, uploaded: number[] = [];
    let finalized = false;
    const video = "urn:li:video:C5505AQH-oV1qvnFtKA";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === source) return mediaResponse(init, size);
      if (url.includes("initializeUpload")) return Response.json({ value: { video, uploadToken: "", uploadUrlsExpireAt: 1633234498985, uploadInstructions: [
        { firstByte: 0, lastByte: 4194303, uploadUrl: "https://www.linkedin.com/dms-uploads/part1" },
        { firstByte: 4194304, lastByte: size - 1, uploadUrl: "https://www.linkedin.com/dms-uploads/part2" },
      ] } });
      if (url.includes("dms-uploads")) { uploaded.push((init!.body as Uint8Array).byteLength); return new Response(null, { headers: { etag: `"part${uploaded.length}"` } }); }
      if (url.includes("finalizeUpload")) {
        expect(JSON.parse(String(init?.body))).toEqual({ finalizeUploadRequest: { video, uploadToken: "", uploadedPartIds: ["part1", "part2"] } });
        finalized = true; return new Response(null);
      }
      expect(finalized).toBe(true);
      expect(url).toBe("https://api.linkedin.com/rest/posts");
      expect(JSON.parse(String(init?.body)).content.media.id).toBe(video);
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
    }));
    expect((await linkedinProvider.publish(args)).providerHandle).toBe("urn:li:share:1");
    expect(uploaded).toEqual([4 * MiB, MiB]);
  });

  it("refuses a source ignoring Range without consuming its body", async () => {
    let canceled = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === source && init?.method === "HEAD") return mediaResponse(init, 40 * MiB);
      if (url === source) return new Response(new ReadableStream({ cancel() { canceled = true; } }));
      return new Response(null, { headers: { location: session } });
    }));
    await expect(youtubeProvider.publish(args)).rejects.toThrow(/range/i);
    expect(canceled).toBe(true);
  });
});
