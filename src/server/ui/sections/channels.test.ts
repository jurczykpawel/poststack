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
let aiDraftPanel: typeof import("./channels").aiDraftPanel;

const s = (h: unknown) => String(h);
// Minimal fixture — only the fields the helpers read matter; cast the rest.
const ch = (over: Partial<PublicChannel>): PublicChannel =>
  ({
    id: "11111111-1111-1111-1111-111111111111",
    platform: "instagram",
    messaging_connection: null,
    last_error: null,
    ai_draft_enabled: false,
    ai_draft_target: "dm",
    ai_draft_prompt: null,
    ai_draft_autosend_dm: false,
    ai_draft_autosend_public: false,
    ...over,
  } as PublicChannel);

beforeAll(async () => {
  ({ messagingConnectionBadge, messagingHint, lastErrorNote, instagramLoginInstructions, reconnectNote, capabilityBadges, aiDraftPanel } =
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
  it("tells a facebook_only IG channel publishing/comments work but DMs need Instagram Login", () => {
    const out = s(messagingHint(ch({ messaging_connection: "facebook_only" })));
    expect(out).toContain("Publishing and comments are active");
    expect(out).toContain("direct messages");
    expect(out).toContain("/api/oauth/instagram-login");
  });
  it("confirms an instagram_login channel has a full connection (DMs, comments, publishing)", () => {
    const out = s(messagingHint(ch({ messaging_connection: "instagram_login" })));
    expect(out).toContain("Full Instagram connection");
    expect(out).toContain("Each Instagram account is connected individually");
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
    expect(out()).toContain("allow access to messages");
  });
  // ── in-panel connection guide: two-path model, when-to-connect, PRO-stays-PRO ──
  it("names both connection paths (Instagram Login + Facebook Login)", () => {
    const o = out();
    expect(o).toContain("Instagram Login");
    expect(o).toContain("Facebook Login");
  });
  it("explains Instagram Login is a full standalone connection that does not require a Facebook page", () => {
    const o = out();
    expect(o).toContain("does not require a Facebook page");
    expect(o).toContain("direct messages");
  });
  it("explains the 'Facebook only' badge means an account is missing DMs", () => {
    const o = out();
    expect(o).toContain("Facebook only");
    expect(o).toContain("direct messages");
  });
  it("defines Advanced Access as the reason DMs don't arrive on a Facebook connection", () => {
    expect(out()).toContain("Advanced Access");
  });
  it("notes PRO features stay PRO regardless of connection method", () => {
    const o = out();
    expect(o).toContain("PRO");
    expect(o).toContain("regardless of how the account is connected");
  });
  // ── durable self-host Meta-app setup ──
  it("walks through the Meta app / Instagram-product setup", () => {
    const o = out();
    expect(o).toContain("developers.facebook.com");
    expect(o).toContain("META_APP_ID");
    expect(o).toContain("Business or Creator");
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

describe("aiDraftPanel (AIDRAFT1 config — Task 8)", () => {
  it("PRO: renders the enable toggle, dm/public/both target select, prompt-override textarea, and two autosend toggles", () => {
    const out = s(aiDraftPanel(ch({}), true, "https://upgrade.example"));
    expect(out).toContain('name="enabled"');
    expect(out).toContain('name="target"');
    expect(out).toContain('value="dm"');
    expect(out).toContain('value="public"');
    expect(out).toContain('value="both"');
    expect(out).toContain('name="prompt"');
    expect(out).toContain('name="autosendDm"');
    expect(out).toContain('name="autosendPublic"');
    expect(out).toContain("/channels/11111111-1111-1111-1111-111111111111/ai-draft");
  });
  it("PRO: each auto-send toggle is labelled advanced — sends without review (no approval)", () => {
    const out = s(aiDraftPanel(ch({}), true, ""));
    const matches = out.match(/advanced — sends without review \(no approval\)/g) ?? [];
    expect(matches.length).toBe(2);
  });
  it("PRO: reflects saved values — enabled checked + target=both selected + override prefilled", () => {
    const out = s(aiDraftPanel(ch({ ai_draft_enabled: true, ai_draft_target: "both", ai_draft_prompt: "Be nice" }), true, ""));
    expect(out).toContain("checked");
    expect(out).toContain('value="both" selected');
    expect(out).toContain("Be nice");
  });
  it("free: shows a PRO upsell, no form fields", () => {
    const out = s(aiDraftPanel(ch({}), false, "https://upgrade.example"));
    expect(out).toContain("PRO");
    expect(out).toContain("https://upgrade.example");
    expect(out).not.toContain('name="enabled"');
  });
  it("escaping: a saved prompt containing <script> renders inert (escaped)", () => {
    const out = s(aiDraftPanel(ch({ ai_draft_prompt: "<script>alert(1)</script>" }), true, ""));
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
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
