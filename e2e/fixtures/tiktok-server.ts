// Offline HTTP boundaries for the dedicated TikTok browser suite.
import { readFileSync } from "node:fs";
const video = readFileSync("e2e/fixtures/tiktok-preview.mp4");
const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
const mediaHttp = await import("../../src/lib/media/ssrf");
mock.module("../../src/lib/media/ssrf", () => ({
  ...mediaHttp,
  safeFetch: async (url: string) => {
    if (url === "https://cdn.example.test/compose.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } });
    if (url !== "https://cdn.example.test/tt3.mp4") throw new Error("Unconfigured media fixture");
    return new Response(video, { headers: { "content-type": "video/mp4" } });
  },
}));
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.href === "https://open.tiktokapis.com/v2/post/publish/creator_info/query/") {
    const token = new Headers(init?.headers).get("Authorization") ?? "";
    if (token.includes("cannot-post")) return Response.json({ error: { code: "spam_risk_too_many_posts" } });
    if (token.includes("info-error")) return Response.json({}, { status: 503 });
    return Response.json({ data: {
      creator_nickname: "TT3 Creator", creator_avatar_url: "",
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
      comment_disabled: true, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 60,
    }, error: { code: "ok" } });
  }
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(input, init);
  throw new Error("Unconfigured HTTP fixture");
}) as typeof fetch;
await import("../../src/server/index");
