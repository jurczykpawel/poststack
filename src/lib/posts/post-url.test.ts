import { describe, expect, it } from "vitest";
import docs from "../../../tests/fixtures/provider-docs/publish-responses.json";
import { postUrlFor } from "./post-url";

describe("postUrlFor", () => {
  it("links the documented X post id (no recorded X channel)", () => {
    expect(postUrlFor("twitter", docs.x.createPost.body.data.id)).toBe(`https://x.com/i/web/status/${docs.x.createPost.body.data.id}`);
  });
  it("builds links from bare ids", () => {
    expect(postUrlFor("youtube", "ZlDpanbR3FM")).toBe("https://www.youtube.com/watch?v=ZlDpanbR3FM");
    expect(postUrlFor("facebook", "122100_998877")).toBe("https://www.facebook.com/122100/posts/998877");
    expect(postUrlFor("facebook", "122343144026008673")).toBe("https://www.facebook.com/watch/?v=122343144026008673");
    expect(postUrlFor("tiktok", "7300000000000000000", "@pavvel11")).toBe("https://www.tiktok.com/@pavvel11/video/7300000000000000000");
  });
  it("returns null when the id cannot make a link", () => {
    expect(postUrlFor("instagram", "179")).toBeNull();
    expect(postUrlFor("tiktok", "v_pub_x", "a")).toBeNull();
    expect(postUrlFor("tiktok", "123", null)).toBeNull();
    expect(postUrlFor("youtube", null)).toBeNull();
  });
});


describe("httpUrl", () => {
  it("keeps http(s) and drops other schemes", async () => {
    const { httpUrl } = await import("./post-url");
    expect(httpUrl("https://youtu.be/x")).toBe("https://youtu.be/x");
    expect(httpUrl("javascript:alert(1)")).toBeNull();
    expect(httpUrl("data:text/html,x")).toBeNull();
    expect(httpUrl(null)).toBeNull();
  });
});
