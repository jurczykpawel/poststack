import { describe, it, expect, beforeAll } from "vitest";

// loadOverview lives alongside deliveryLabel and imports the db singleton, which
// requires DATABASE_URL at import time. The label map is pure (no query), so a dummy
// connection string is enough to import it; nothing here ever opens a connection.
let deliveryLabel: typeof import("@/lib/stats/overview").deliveryLabel;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
  ({ deliveryLabel } = await import("@/lib/stats/overview"));
});

describe("deliveryLabel", () => {
  it("maps known outbound task names to friendly, identity-free labels", () => {
    expect(deliveryLabel("outgoing-message")).toBe("DM");
    expect(deliveryLabel("outgoing-comment")).toBe("Comment reply");
    expect(deliveryLabel("outgoing-private-reply")).toBe("Private reply");
    expect(deliveryLabel("follow-gate")).toBe("Follow-gate");
    expect(deliveryLabel("sequence-step")).toBe("Sequence step");
  });

  it("falls back to a generic label for unknown task names", () => {
    expect(deliveryLabel("something-new")).toBe("Message");
  });
});
