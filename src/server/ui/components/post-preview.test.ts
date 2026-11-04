import { expect, it } from "vitest";
import docs from "../../../../tests/fixtures/provider-docs/publish-responses.json";
import { postPreview } from "./post-preview";

it("names X in the destination label for a stored twitter channel", async () => {
  const out = String(await postPreview({ platform: "twitter", channelName: "Creator", text: docs.x.createPost.body.data.text, imageUrl: null, video: false, at: null, url: `https://x.com/i/web/status/${docs.x.createPost.body.data.id}` }));
  expect(out).toContain("View on X ↗");
});
