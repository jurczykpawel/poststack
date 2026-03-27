import { describe, it, expect } from "vitest";
import { META_API_VERSION, GRAPH_API_BASE, META_OAUTH_BASE } from "./constants";

describe("Meta API constants", () => {
  it("exports a valid API version format", () => {
    expect(META_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it("GRAPH_API_BASE uses META_API_VERSION", () => {
    expect(GRAPH_API_BASE).toBe(`https://graph.facebook.com/${META_API_VERSION}`);
  });

  it("META_OAUTH_BASE uses META_API_VERSION", () => {
    expect(META_OAUTH_BASE).toBe(`https://www.facebook.com/${META_API_VERSION}`);
  });
});
