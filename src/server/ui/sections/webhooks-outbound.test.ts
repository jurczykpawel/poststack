import { describe, it, expect, beforeAll } from "vitest";

// webhooks-outbound.ts → events/webhooks/db → env.ts validates required vars at import; set first.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderOutboundWebhooks: typeof import("./webhooks-outbound").renderOutboundWebhooks;
let EVENT_TYPES: typeof import("@/lib/events").EVENT_TYPES;
type WebhookEndpoint = import("@/lib/webhooks/endpoints").WebhookEndpoint;

const s = (h: unknown) => String(h);

// Minimal fixture — only the fields the renderer reads matter; cast the rest.
const ep = (over: Partial<WebhookEndpoint>): WebhookEndpoint =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "ws",
    url: "https://hooks.example.com/a",
    secret: "whsec_deadbeef",
    secret_secondary: null,
    event_types: [],
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as WebhookEndpoint);

beforeAll(async () => {
  ({ renderOutboundWebhooks } = await import("./webhooks-outbound"));
  ({ EVENT_TYPES } = await import("@/lib/events"));
});

const base = { canManage: true, upgradeUrl: "/pricing" };

describe("renderOutboundWebhooks — list", () => {
  it("renders the endpoint url and an active badge", () => {
    const out = s(renderOutboundWebhooks([ep({ url: "https://hooks.example.com/live" })], base));
    expect(out).toContain("https://hooks.example.com/live");
    expect(out).toContain("Active");
  });

  it("shows 'All events' when no event types are selected", () => {
    const out = s(renderOutboundWebhooks([ep({ event_types: [] })], base));
    expect(out).toContain("All events");
  });

  it("lists the specific subscribed events (not 'All events')", () => {
    const out = s(renderOutboundWebhooks([ep({ event_types: ["post.published", "contact.created"] })], base));
    expect(out).toContain("post.published");
    expect(out).toContain("contact.created");
    // The "All events" pill text appears only in the add-form context, not as this endpoint's label.
    expect(out).not.toMatch(/Events:[^<]*<span class="badge tone-info">All events/);
  });

  it("marks an inactive endpoint", () => {
    const out = s(renderOutboundWebhooks([ep({ active: false })], base));
    expect(out).toContain("Inactive");
    expect(out).toContain("Enable"); // toggle offers to re-enable
  });

  it("renders the secret behind a reveal toggle (masked placeholder present)", () => {
    const out = s(renderOutboundWebhooks([ep({ secret: "whsec_supersecret" })], base));
    expect(out).toContain("whsec_supersecret"); // revealed value in DOM (x-show gated)
    expect(out).toContain("whsec_••••••••••••"); // masked placeholder
    expect(out).toContain("Reveal");
  });

  it("offers rotate + delete (with confirm) per endpoint", () => {
    const out = s(renderOutboundWebhooks([ep({})], base));
    expect(out).toContain("Rotate secret");
    expect(out).toContain('hx-delete="/webhooks/outbound/11111111-1111-4111-8111-111111111111"');
    expect(out).toContain("hx-confirm");
  });

  it("shows an empty-state when there are no endpoints", () => {
    const out = s(renderOutboundWebhooks([], base));
    expect(out).toContain("No outbound endpoints yet");
  });
});

describe("renderOutboundWebhooks — add form", () => {
  it("renders a checkbox per EVENT_TYPE", () => {
    const out = s(renderOutboundWebhooks([], base));
    for (const t of EVENT_TYPES) {
      expect(out).toContain(`value="${t}"`);
    }
    // One add-form checkbox per event type (id prefix "new-").
    const matches = out.match(/id="new-[^"]+"/g) ?? [];
    expect(matches.length).toBe(EVENT_TYPES.length);
  });

  it("posts the add form to /webhooks/outbound targeting #wh-outbound", () => {
    const out = s(renderOutboundWebhooks([], base));
    expect(out).toContain('hx-post="/webhooks/outbound"');
    expect(out).toContain('hx-target="#wh-outbound"');
  });
});

describe("renderOutboundWebhooks — gating + escaping", () => {
  it("shows a PRO prompt (no add form) when the instance is not entitled", () => {
    const out = s(renderOutboundWebhooks([], { canManage: false, upgradeUrl: "/pricing" }));
    expect(out).toContain("PRO");
    expect(out).toContain("/pricing");
    expect(out).not.toContain('hx-post="/webhooks/outbound"'); // no management UI
  });

  it("escapes a malicious url so injected markup is inert", () => {
    const evil = 'https://evil.example/"><script>alert(1)</script>';
    const out = s(renderOutboundWebhooks([ep({ url: evil })], base));
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes a malicious secret value", () => {
    const out = s(renderOutboundWebhooks([ep({ secret: 'whsec_"><img src=x onerror=alert(1)>' })], base));
    expect(out).not.toContain("<img src=x onerror=alert(1)>");
    expect(out).toContain("&lt;img");
  });
});
