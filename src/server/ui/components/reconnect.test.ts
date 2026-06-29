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
