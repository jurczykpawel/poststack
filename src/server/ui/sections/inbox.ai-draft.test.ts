import { describe, it, expect, beforeAll } from "vitest";

// Stub env vars before any imports that trigger env validation.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderThread: typeof import("@/server/routes/dashboard").renderThread;

const s = (h: unknown) => String(h);

function makeConv(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    platform: "facebook",
    status: "open",
    thread_type: "dm" as const,
    thread_ref: "",
    is_automation_paused: false,
    needs_manual_reply: false,
    assigned_to: null,
    last_inbound_at: null,
    subject: null,
    channel: { id: "ch-1", display_name: "Page", platform: "facebook" },
    contact: {
      id: "c-1",
      display_name: "Alice",
      avatar_url: null,
      contact_channels: [{ platform_sender_id: "ps-1", platform_username: null }],
    },
    ...overrides,
  };
}

beforeAll(async () => {
  ({ renderThread } = await import("@/server/routes/dashboard"));
});

describe("renderThread — on-demand AI draft control", () => {
  it("shows the Generate reply control when canAiDraft is on", async () => {
    const out = s(await renderThread(makeConv(), [], { canAiDraft: true }));
    expect(out).toContain("Generate reply");
    expect(out).toContain("/inbox/11111111-1111-1111-1111-111111111111/ai-draft");
    // hx-vals is rendered as an HTML attribute, so the JSON quotes are entity-escaped (the browser
    // un-escapes them before handing the value to htmx).
    expect(out).toContain(`&quot;target&quot;:&quot;dm&quot;`);
  });

  it("hides the control entirely when canAiDraft is off (free / no feature)", async () => {
    const out = s(await renderThread(makeConv(), [], { canAiDraft: false }));
    expect(out).not.toContain("Generate reply");
    expect(out).not.toContain("/ai-draft");
  });

  it("offers the public option ONLY on a comment thread", async () => {
    const dm = s(await renderThread(makeConv({ thread_type: "dm" }), [], { canAiDraft: true }));
    expect(dm).not.toContain(`&quot;target&quot;:&quot;public&quot;`);
    expect(dm).not.toContain("Generate public reply");

    const comment = s(await renderThread(makeConv({ thread_type: "comment", thread_ref: "POST-1" }), [], { canAiDraft: true }));
    expect(comment).toContain("Generate public reply");
    expect(comment).toContain(`&quot;target&quot;:&quot;public&quot;`);
  });

  it("escapes dynamic output (contact name) in the rendered thread", async () => {
    const conv = makeConv({
      contact: {
        id: "c-x",
        display_name: "<script>alert(1)</script>",
        avatar_url: null,
        contact_channels: [{ platform_sender_id: "ps-x", platform_username: null }],
      },
    });
    const out = s(await renderThread(conv, [], { canAiDraft: true }));
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
