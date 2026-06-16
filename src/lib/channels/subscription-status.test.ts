import { describe, it, expect, beforeAll, vi } from "vitest";

let channelSubscriptionStatus: typeof import("./subscription-status").channelSubscriptionStatus;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;

beforeAll(async () => {
  // The module imports the db singleton (needs a connection string at import time); these tests call
  // channelSubscriptionStatus directly with an injected fetch, so no query actually runs.
  process.env.DATABASE_URL = "postgres://x:x@localhost:5432/x";
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.META_APP_ID ??= "ci-app-id";
  process.env.META_APP_SECRET ??= "ci-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "ci-verify";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ channelSubscriptionStatus } = await import("./subscription-status"));
});

function fakeFetch(fields: string[] | { error: string }) {
  return vi.fn(async () => {
    if ("error" in (fields as { error?: string }) && (fields as { error: string }).error) {
      return new Response(JSON.stringify({ error: { message: (fields as { error: string }).error } }), { status: 400 });
    }
    return new Response(JSON.stringify({ data: [{ subscribed_fields: fields }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("channelSubscriptionStatus (WEBHOOKSUB1)", () => {
  it("FB: reports missing fields against the expected set", async () => {
    const ch = {
      id: "c1", platform: "facebook", platform_id: "PAGE1", display_name: "Page One",
      token_encrypted: encryptTokens({ access_token: "T" }),
    };
    const st = await channelSubscriptionStatus(ch, fakeFetch(["messages", "messaging_postbacks", "feed"]));
    expect(st.ok).toBe(false);
    expect(st.pageId).toBe("PAGE1");
    expect(st.active).toContain("messages");
    expect(st.missing).toEqual(expect.arrayContaining(["message_echoes", "message_reactions", "message_reads", "message_deliveries"]));
  });

  it("FB: ok=true when fully subscribed", async () => {
    const ch = {
      id: "c2", platform: "facebook", platform_id: "PAGE2", display_name: null,
      token_encrypted: encryptTokens({ access_token: "T" }),
    };
    const st = await channelSubscriptionStatus(
      ch,
      fakeFetch(["messages", "messaging_postbacks", "messaging_optins", "message_echoes", "message_reactions", "message_reads", "message_deliveries", "feed"]),
    );
    expect(st.ok).toBe(true);
    expect(st.missing).toEqual([]);
  });

  it("IG: resolves the linked page id from the token", async () => {
    const ch = {
      id: "c3", platform: "instagram", platform_id: "IGID", display_name: "IG",
      token_encrypted: encryptTokens({ access_token: "T", page_id: "LINKED_PAGE" }),
    };
    const fetchImpl = fakeFetch(["messages"]);
    const st = await channelSubscriptionStatus(ch, fetchImpl);
    expect(st.pageId).toBe("LINKED_PAGE");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/LINKED_PAGE/subscribed_apps");
  });

  it("surfaces a Graph error instead of throwing", async () => {
    const ch = {
      id: "c4", platform: "facebook", platform_id: "PAGE4", display_name: "P4",
      token_encrypted: encryptTokens({ access_token: "T" }),
    };
    const st = await channelSubscriptionStatus(ch, fakeFetch({ error: "bad token" }));
    expect(st.ok).toBe(false);
    expect(st.error).toContain("bad token");
  });
});
