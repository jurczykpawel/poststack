import { describe, it, expect, beforeAll } from "vitest";

// Stub env vars before any imports that trigger env validation.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderThread: typeof import("@/server/routes/dashboard").renderThread;

const s = (h: unknown) => String(h);
const CONV_ID = "11111111-1111-1111-1111-111111111111";
const APPR_ID = "22222222-2222-2222-2222-222222222222";

function makeConv(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
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

describe("renderThread — pending-approval draft bubbles", () => {
  it("renders an ai_auto draft bubble: text + AI tag + DM target + Accept/Edit/Reject", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "Your order ships today.", commentText: null }],
      }),
    );
    expect(out).toContain("Your order ships today.");
    expect(out).toContain("AI draft");
    expect(out).toContain("awaiting approval");
    expect(out).toContain("DM");
    // Three actions, wired to the inbox approval routes.
    expect(out).toContain("Accept");
    expect(out).toContain("Edit");
    expect(out).toContain("Reject");
    expect(out).toContain(`/inbox/approval/${APPR_ID}/approve`);
    expect(out).toContain(`/inbox/approval/${APPR_ID}/reject`);
    expect(out).toContain(`/inbox/approval/${APPR_ID}/edit`);
  });

  it("renders a rule-hold draft identically but tagged 'Held for approval'", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "rule", dmText: "Thanks for reaching out!", commentText: null }],
      }),
    );
    expect(out).toContain("Thanks for reaching out!");
    expect(out).toContain("Held for approval");
    expect(out).not.toContain("AI draft");
    expect(out).toContain("Accept");
    expect(out).toContain("Edit");
    expect(out).toContain("Reject");
  });

  it("tags a public-comment draft as 'public comment reply'", async () => {
    const out = s(
      await renderThread(makeConv({ thread_type: "comment", thread_ref: "POST-1" }), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: null, commentText: "Glad you liked it!" }],
      }),
    );
    expect(out).toContain("Glad you liked it!");
    expect(out).toContain("public comment reply");
  });

  it("escapes proposed text — a <script> payload is inert", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "<script>alert(1)</script>", commentText: null }],
      }),
    );
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders no draft bubble when there are no pending approvals", async () => {
    const out = s(await renderThread(makeConv(), [], { drafts: [] }));
    expect(out).not.toContain("awaiting approval");
    expect(out).not.toContain("Held for approval");
    expect(out).not.toContain("/inbox/approval/");
  });
});

// ADUX1: Edit is a client-side toggle (Alpine `editing`), not an always-visible textarea — the
// textarea only exists inside the `x-show="editing"` edit form, and Save/Cancel replace Accept/
// Edit/Reject while editing.
describe("renderThread — pending-approval draft bubble edit toggle (ADUX1)", () => {
  it("does not render an unconditional/always-visible textarea", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "Your order ships today.", commentText: null }],
      }),
    );
    // The textarea must live inside the x-show="editing" form, not sit bare in the markup.
    expect(out).toMatch(/x-show="editing"[^>]*>[\s\S]*<textarea/);
  });

  it("has an Alpine edit toggle with Save/Cancel available in the edit state", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "Your order ships today.", commentText: null }],
      }),
    );
    expect(out).toContain('x-data="{ editing: false }"');
    expect(out).toContain("Save");
    expect(out).toContain("Cancel");
  });

  it("Cancel resets the textarea to its original value before hiding it (no stale abandoned edit)", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "Your order ships today.", commentText: null }],
      }),
    );
    expect(out).toContain("$refs.ta.value = $refs.ta.defaultValue");
  });
});

// ADDEL1: a "Delete" button lets an operator discard a draft entirely (distinct from Reject, which
// keeps a rejected row visible in "Recently resolved").
describe("renderThread — pending-approval draft bubble Delete (ADDEL1)", () => {
  it("renders a Delete button wired to DELETE /inbox/approval/:id with a confirm prompt", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "Your order ships today.", commentText: null }],
      }),
    );
    expect(out).toContain(`hx-delete="/inbox/approval/${APPR_ID}"`);
    expect(out).toContain("hx-confirm=");
    expect(out).toContain("Delete");
  });
});

// Bug: clicking "Generate reply" required a manual browser refresh to see the drafted reply appear,
// because the AI-draft job runs async (worker) and the enqueue response has no draft yet. Fixed with
// a self-terminating poll of the drafts region (see renderDraftsRegion in dashboard.ts).
describe("renderThread — drafts-region self-terminating poll", () => {
  it("does NOT poll on a plain thread load with no drafts (pollDrafts unset — the common case)", async () => {
    const out = s(await renderThread(makeConv(), [], { drafts: [] }));
    expect(out).toContain('id="thread-drafts"');
    expect(out).not.toMatch(/thread-drafts"[^>]*hx-get/);
  });

  it("starts polling when pollDrafts=true and there is no draft yet (right after 'Generate reply')", async () => {
    const out = s(await renderThread(makeConv(), [], { drafts: [], pollDrafts: true }));
    expect(out).toContain(`hx-get="/inbox/${CONV_ID}/drafts?attempt=1"`);
    expect(out).toContain('hx-trigger="load delay:3s"');
    expect(out).toContain('hx-swap="outerHTML"');
  });

  it("stops polling (no hx-get) once a draft exists, even when pollDrafts=true", async () => {
    const out = s(
      await renderThread(makeConv(), [], {
        pollDrafts: true,
        drafts: [{ id: APPR_ID, source: "ai_auto", dmText: "Your reply is ready.", commentText: null }],
      }),
    );
    expect(out).toContain("Your reply is ready.");
    expect(out).not.toMatch(/thread-drafts"[^>]*hx-get/);
  });
});
