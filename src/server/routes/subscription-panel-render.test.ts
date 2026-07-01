import { describe, it, expect, beforeAll } from "vitest";
import type { ChannelSubscriptionStatus } from "@/lib/channels/subscription-status";

// WEBHOOKSUB1 clarity: a DUAL Instagram channel keeps TWO subscriptions (its linked Facebook Page +
// Instagram Login per-account). The panel must make that obvious — which field set is which — and must
// NOT show the FB-page-only "pages_messaging Advanced Access" caveat for an IG-Login subscription
// (where message_reactions delivers on Standard Access). Pure render test (no DB touched).
let renderSubscriptionPanel: typeof import("./dashboard").renderSubscriptionPanel;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5433/test";
  ({ renderSubscriptionPanel } = await import("./dashboard"));
});

const PAGE_FIELDS = ["messages", "messaging_postbacks", "message_echoes", "message_reactions", "message_reads", "message_deliveries", "feed"];
const IG_FIELDS = ["messages", "messaging_postbacks", "message_reactions", "messaging_seen", "comments", "live_comments"];

const dual: ChannelSubscriptionStatus = {
  channelId: "c1", platform: "instagram", displayName: "CD", kind: "page", pageId: "P1",
  active: PAGE_FIELDS, missing: [], ok: true,
  igLogin: { active: IG_FIELDS, missing: [], ok: true },
};
const igOnly: ChannelSubscriptionStatus = {
  channelId: "c2", platform: "instagram", displayName: "SoloIG", kind: "instagram_login", pageId: null,
  active: IG_FIELDS, missing: [], ok: true,
};
const fbOnly: ChannelSubscriptionStatus = {
  channelId: "c3", platform: "facebook", displayName: "TipStack", kind: "page", pageId: "P3",
  active: PAGE_FIELDS, missing: [], ok: true,
};

describe("renderSubscriptionPanel — clear labelling of dual vs IG-Login subscriptions", () => {
  it("a DUAL Instagram channel names BOTH subscriptions (Facebook Page + Instagram Login) so the two field sets aren't mixed up", () => {
    const html = renderSubscriptionPanel([dual]).toString();
    expect(html).toContain("Facebook Page");            // the top-level / right-column set is labelled the FB Page side
    expect(html).toContain("Instagram Login (per-account)"); // the other set stays clearly the IG side
    // the message_reactions caveat now clarifies the IG DMs are fine on Standard Access
    expect(html).toContain("Standard Access");
  });

  it("does NOT show the FB-page pages_messaging caveat for an IG-Login-only channel (it delivers on Standard Access)", () => {
    const html = renderSubscriptionPanel([igOnly]).toString();
    expect(html).not.toContain("pages_messaging");
    expect(html).toContain("live_comments"); // its real IG fields still render
  });

  it("keeps the pages_messaging caveat for a pure Facebook Page channel", () => {
    const html = renderSubscriptionPanel([fbOnly]).toString();
    expect(html).toContain("pages_messaging");
    expect(html).not.toContain("Instagram Login (per-account)");
  });
});
