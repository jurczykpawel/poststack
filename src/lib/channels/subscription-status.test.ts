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
      fakeFetch(["messages", "messaging_postbacks", "message_echoes", "message_reactions", "message_reads", "message_deliveries", "feed"]),
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

  it("IG-Login-only: per-account subscription on graph.instagram.com, no 'no linked page id'", async () => {
    const ch = {
      id: "c5", platform: "instagram", platform_id: "IGID", display_name: "IG Login",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }), // no page_id, empty FB token
    };
    const fetchImpl = fakeFetch(["messages"]); // only `messages` currently subscribed
    const st = await channelSubscriptionStatus(ch, fetchImpl);

    expect(st.kind).toBe("instagram_login");
    expect(st.error).toBeUndefined(); // NOT "no linked page id"
    expect(st.pageId).toBeNull();
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("graph.instagram.com");
    expect(url).toContain("/IGID/subscribed_apps");
    expect(st.active).toContain("messages");
    // not-yet-subscribed IG-Login fields surface as missing (incl. comments for comment→DM).
    expect(st.missing).toContain("comments");
    expect(st.ok).toBe(false);
  });

  it("DUAL channel (FB page + IG-Login token): page status PLUS igLogin sub-result", async () => {
    const ch = {
      id: "c7", platform: "instagram", platform_id: "IGID7", display_name: "Dual",
      token_encrypted: encryptTokens({ access_token: "FB", page_id: "PG", messaging_token: "IGQW" }),
    };
    // Branch on host: the page GET on graph.facebook.com vs the IG-Login GET on graph.instagram.com.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("graph.instagram.com")) {
        return new Response(JSON.stringify({ data: [{ subscribed_fields: ["messages"] }] }), { status: 200 });
      }
      // page subscription: fully subscribed
      return new Response(
        JSON.stringify({ data: [{ subscribed_fields: ["messages", "messaging_postbacks", "message_echoes", "message_reactions", "message_reads", "message_deliveries", "feed"] }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const st = await channelSubscriptionStatus(ch, fetchImpl);

    // top-level reflects the PAGE subscription
    expect(st.kind).toBe("page");
    expect(st.pageId).toBe("PG");
    expect(st.active).toEqual(expect.arrayContaining(["messages", "feed"]));
    expect(st.missing).toEqual([]);

    // A9: the page set is complete, but the attached igLogin sub-result is NOT — so the top-level
    // `ok` must FOLD igLogin and read false, never a misleading "Fully subscribed".
    expect(st.ok).toBe(false);

    // ...and the IG-Login per-account sub is ALSO surfaced
    expect(st.igLogin).toBeDefined();
    expect(st.igLogin!.active).toContain("messages");
    expect(st.igLogin!.missing).toContain("comments");
    expect(st.igLogin!.ok).toBe(false);

    // and an IG-Login GET hit graph.instagram.com for IGID7
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    const igCall = calls.find((u) => u.includes("graph.instagram.com"));
    expect(igCall).toBeDefined();
    expect(igCall).toContain("/IGID7/subscribed_apps");
  });

  it("DUAL channel fully subscribed on BOTH page and igLogin → top-level ok=true", async () => {
    const ch = {
      id: "c7b", platform: "instagram", platform_id: "IGID7b", display_name: "Dual OK",
      token_encrypted: encryptTokens({ access_token: "FB", page_id: "PG", messaging_token: "IGQW" }),
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("graph.instagram.com")) {
        // every IG-Login field present (matches INSTAGRAM_LOGIN_FIELDS)
        return new Response(JSON.stringify({ data: [{ subscribed_fields: ["messages", "messaging_postbacks", "message_reactions", "messaging_seen", "comments", "live_comments"] }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: [{ subscribed_fields: ["messages", "messaging_postbacks", "message_echoes", "message_reactions", "message_reads", "message_deliveries", "feed"] }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const st = await channelSubscriptionStatus(ch, fetchImpl);
    expect(st.missing).toEqual([]);
    expect(st.igLogin!.missing).toEqual([]);
    expect(st.ok).toBe(true);
  });

  it("FB-only channel (no messaging_token): no igLogin sub-result", async () => {
    const ch = {
      id: "c8", platform: "facebook", platform_id: "PAGE8", display_name: "FB only",
      token_encrypted: encryptTokens({ access_token: "T" }),
    };
    const st = await channelSubscriptionStatus(ch, fakeFetch(["messages"]));
    expect(st.igLogin).toBeUndefined();
  });

  it("page-based channels carry kind=page", async () => {
    const ch = {
      id: "c6", platform: "facebook", platform_id: "PAGE6", display_name: "P6",
      token_encrypted: encryptTokens({ access_token: "T" }),
    };
    const st = await channelSubscriptionStatus(ch, fakeFetch(["messages"]));
    expect(st.kind).toBe("page");
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
