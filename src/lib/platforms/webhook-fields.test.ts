import { describe, it, expect } from "vitest";
import {
  expectedPageFields,
  diffSubscribedFields,
  diffFields,
  instagramLoginFields,
  FACEBOOK_PAGE_FIELDS,
} from "./webhook-fields";

describe("webhook-fields (WEBHOOKSUB1 source of truth)", () => {
  it("includes the messaging-completeness fields and excludes the invalid `comments` page field", () => {
    for (const p of ["facebook", "instagram"] as const) {
      const f = expectedPageFields(p);
      expect(f).toContain("messages");
      expect(f).toContain("message_echoes");
      expect(f).toContain("message_reactions");
      expect(f).toContain("message_reads");
      expect(f).toContain("message_deliveries");
      expect(f).not.toContain("comments"); // instagram-object field, not a valid page field (#100)
      // WHSUBOPTIN1: no consumer for optin events + Meta won't durably hold the subscription,
      // so it must not be a required field (it flapped as a permanent false "missing").
      expect(f).not.toContain("messaging_optins");
    }
  });

  it("diffs current vs expected into active + missing", () => {
    const current = ["messages", "messaging_postbacks", "feed"]; // a stale partial subscription
    const { active, missing } = diffSubscribedFields("facebook", current);
    expect(active).toContain("messages");
    expect(active).toContain("feed");
    expect(missing).toContain("message_echoes");
    expect(missing).toContain("message_reactions");
    expect(missing).toContain("message_reads");
    expect(missing).toContain("message_deliveries");
    // every field is accounted for exactly once across active+missing
    expect([...active, ...missing].sort()).toEqual([...FACEBOOK_PAGE_FIELDS].sort());
  });

  it("reports no missing when fully subscribed", () => {
    const { missing } = diffSubscribedFields("facebook", [...FACEBOOK_PAGE_FIELDS]);
    expect(missing).toEqual([]);
  });
});

describe("instagramLoginFields (IG-Login per-account subscribed_apps set)", () => {
  it("is exactly the 5 instagram-object fields including `comments`", () => {
    expect(instagramLoginFields()).toEqual([
      "messages",
      "messaging_postbacks",
      "message_reactions",
      "messaging_seen",
      "comments",
    ]);
    // `comments` is REQUIRED so an IG-Login-only channel receives comment webhooks for comment→DM.
    expect(instagramLoginFields()).toContain("comments");
  });

  it("uses the exact instagram-object field names (v25.0 dashboard), NOT invalid/page-only names", () => {
    const f = instagramLoginFields();
    // instagram object uses `message_reactions` + `messaging_seen` (verified against the live app's
    // Webhooks field list). `messaging_reactions` is NOT a valid field — must never be requested.
    expect(f).toContain("message_reactions");
    expect(f).toContain("messaging_seen");
    expect(f).not.toContain("messaging_reactions");
    expect(f).not.toContain("message_reads");
    expect(f).not.toContain("message_deliveries");
    expect(f).not.toContain("message_echoes");
    expect(f).not.toContain("feed");
  });
});

describe("diffFields (generic DRY diff)", () => {
  it("splits expected into active (present) + missing (absent)", () => {
    expect(diffFields(["a", "b"], ["a"])).toEqual({ active: ["a"], missing: ["b"] });
  });

  it("backs diffSubscribedFields (delegation)", () => {
    const current = ["messages", "messaging_postbacks", "feed"];
    expect(diffSubscribedFields("facebook", current)).toEqual(diffFields(FACEBOOK_PAGE_FIELDS, current));
  });
});
