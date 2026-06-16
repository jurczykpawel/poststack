import { describe, it, expect } from "vitest";
import { expectedPageFields, diffSubscribedFields, FACEBOOK_PAGE_FIELDS } from "./webhook-fields";

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
