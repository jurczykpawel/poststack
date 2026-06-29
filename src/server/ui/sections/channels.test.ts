import { describe, it, expect, beforeAll } from "vitest";
import type { PublicChannel } from "@/lib/channels/service";

// channels.ts → db/auth/schema → env.ts validates required vars at import; set them before importing.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let messagingConnectionBadge: typeof import("./channels").messagingConnectionBadge;
let messagingHint: typeof import("./channels").messagingHint;
let lastErrorNote: typeof import("./channels").lastErrorNote;
let instagramLoginInstructions: typeof import("./channels").instagramLoginInstructions;
let reconnectNote: typeof import("./channels").reconnectNote;
let capabilityBadges: typeof import("./channels").capabilityBadges;

const s = (h: unknown) => String(h);
// Minimal fixture — only the fields the helpers read matter; cast the rest.
const ch = (over: Partial<PublicChannel>): PublicChannel =>
  ({ platform: "instagram", messaging_connection: null, last_error: null, ...over } as PublicChannel);

beforeAll(async () => {
  ({ messagingConnectionBadge, messagingHint, lastErrorNote, instagramLoginInstructions, reconnectNote, capabilityBadges } =
    await import("./channels"));
});

describe("messagingConnectionBadge (B1/B4)", () => {
  it("renders an 'Instagram Login' pill for an instagram_login channel", () => {
    expect(s(messagingConnectionBadge(ch({ messaging_connection: "instagram_login" })))).toContain("Instagram Login");
  });
  it("renders a 'Facebook only' pill for a facebook_only channel", () => {
    expect(s(messagingConnectionBadge(ch({ messaging_connection: "facebook_only" })))).toContain("Facebook only");
  });
  it("renders nothing for a channel with no messaging connection (e.g. Facebook)", () => {
    expect(s(messagingConnectionBadge(ch({ platform: "facebook", messaging_connection: null }))).trim()).toBe("");
  });
});

describe("messagingHint (B2)", () => {
  it("warns a facebook_only IG channel that DMs are not guaranteed + links to Instagram Login", () => {
    const out = s(messagingHint(ch({ messaging_connection: "facebook_only" })));
    expect(out).toContain("Instagram Login");
    expect(out).toContain("not guaranteed");
    expect(out).toContain("/api/oauth/instagram-login");
  });
  it("renders nothing for an instagram_login channel", () => {
    expect(s(messagingHint(ch({ messaging_connection: "instagram_login" }))).trim()).toBe("");
  });
  it("renders nothing for a Facebook channel", () => {
    expect(s(messagingHint(ch({ platform: "facebook", messaging_connection: null }))).trim()).toBe("");
  });
});

describe("instagramLoginInstructions (A2)", () => {
  const out = () => s(instagramLoginInstructions());
  it("shows the OAuth redirect URI to register", () => {
    expect(out()).toContain("/api/oauth/instagram-login/callback");
  });
  it("names the Meta app config vars the instance needs", () => {
    expect(out()).toContain("INSTAGRAM_APP_ID");
    expect(out()).toContain("INSTAGRAM_APP_SECRET");
  });
  it("mentions the IG account 'allow access to messages' toggle", () => {
    expect(out()).toContain("messages");
  });
});

describe("reconnectNote (A3) — dual-channel reconnect clarification", () => {
  it("renders for an instagram_login channel: links to the Facebook reauth + warns about publishing", () => {
    const out = s(reconnectNote(ch({ messaging_connection: "instagram_login" })));
    expect(out).toContain("/api/oauth/instagram");
    expect(out).toContain("Facebook");
    expect(out.toLowerCase()).toContain("publishing");
  });
  it("renders nothing for a facebook_only channel", () => {
    expect(s(reconnectNote(ch({ messaging_connection: "facebook_only" }))).trim()).toBe("");
  });
  it("renders nothing for a Facebook channel", () => {
    expect(s(reconnectNote(ch({ platform: "facebook", messaging_connection: null }))).trim()).toBe("");
  });
});

describe("capabilityBadges (A13) — suppress misleading DM pill for facebook_only", () => {
  it("omits the DM pill for a facebook_only IG channel", () => {
    expect(s(capabilityBadges(ch({ messaging_connection: "facebook_only" })))).not.toContain(">DM<");
  });
  it("keeps the DM pill for an instagram_login IG channel", () => {
    expect(s(capabilityBadges(ch({ messaging_connection: "instagram_login" })))).toContain(">DM<");
  });
});

describe("lastErrorNote (B3)", () => {
  it("surfaces the recorded last_error text", () => {
    expect(s(lastErrorNote(ch({ last_error: "boom" })))).toContain("boom");
  });
  it("renders nothing when there is no error", () => {
    expect(s(lastErrorNote(ch({ last_error: null }))).trim()).toBe("");
  });
});
