import { describe, expect, it } from "vitest";
import { postUrlFor, videoThumbFor } from "./post-url";

describe("postUrlFor", () => {
  it("builds links from bare ids", () => {
    expect(postUrlFor("youtube", "ZlDpanbR3FM")).toBe("https://www.youtube.com/watch?v=ZlDpanbR3FM");
    expect(postUrlFor("facebook", "1_2")).toBe("https://www.facebook.com/1_2");
    expect(postUrlFor("tiktok", "7300000000000000000", "@pavvel11")).toBe("https://www.tiktok.com/@pavvel11/video/7300000000000000000");
  });
  it("returns null when the id cannot make a link", () => {
    expect(postUrlFor("instagram", "179")).toBeNull();
    expect(postUrlFor("tiktok", "v_pub_x", "a")).toBeNull();
    expect(postUrlFor("tiktok", "123", null)).toBeNull();
    expect(postUrlFor("youtube", null)).toBeNull();
  });
});

describe("videoThumbFor", () => {
  it("gives a YouTube still only for a plausible id", () => {
    expect(videoThumbFor("youtube", "ZlDpanbR3FM")).toBe("https://i.ytimg.com/vi/ZlDpanbR3FM/hqdefault.jpg");
    expect(videoThumbFor("youtube", "../x")).toBeNull();
    expect(videoThumbFor("facebook", "ZlDpanbR3FM")).toBeNull();
  });
});
