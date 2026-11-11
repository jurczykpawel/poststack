import { describe, it, expect } from "vitest";
import { reconnectHref } from "./reconnect";

const base = { id: "c1", connection_mode: "oauth" as const };
describe("reconnectHref IG-Login awareness", () => {
  it("IG-Login channel → /api/oauth/instagram-login", () => {
    expect(reconnectHref({ ...base, platform: "instagram", messaging_connection: "instagram_login" })).toBe("/api/oauth/instagram-login");
  });
  it("Facebook-login IG channel → /api/oauth/instagram", () => {
    expect(reconnectHref({ ...base, platform: "instagram", messaging_connection: "facebook_only" })).toBe("/api/oauth/instagram");
  });
  it("Facebook channel unchanged → /api/oauth/facebook", () => {
    expect(reconnectHref({ ...base, platform: "facebook", messaging_connection: null })).toBe("/api/oauth/facebook");
  });
  it("derived channel → /sources (unchanged)", () => {
    expect(reconnectHref({ id: "c1", connection_mode: "derived", platform: "instagram", messaging_connection: "instagram_login" })).toBe("/sources");
  });
});


describe("publisher reconnect destinations", () => {
  it.each([["tiktok", "tiktok"], ["linkedin", "linkedin"], ["twitter", "x"], ["threads", "threads"]])("%s starts the hosted flow", (platform, slug) => {
    expect(reconnectHref({ ...base, platform })).toBe(`/api/oauth/connect/${slug}`);
  });
});

describe("LinkedIn Company Page reconnect", () => {
  it("a page channel re-runs the Company Page flow; a profile channel keeps the plain one", () => {
    expect(reconnectHref({ ...base, platform: "linkedin", metadata: { subKind: "organization" } })).toBe("/api/oauth/connect/linkedin?pages=1");
    expect(reconnectHref({ ...base, platform: "linkedin", metadata: {} })).toBe("/api/oauth/connect/linkedin");
    expect(reconnectHref({ ...base, platform: "linkedin", metadata: null })).toBe("/api/oauth/connect/linkedin");
  });
});
