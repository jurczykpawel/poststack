import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// Consumer contract: an API client reading a thread must learn WHY a reply it sent never reached the
// contact. The send runs through the real worker + delivery state machine; only the network edge is
// replaced, and it answers with Graph error bodies in the shape Meta returns (classified by the real
// assertMetaOk). The assertions read the HTTP response a client consumes, not the stored row.
const graph = vi.hoisted(() => ({ body: "", status: 400, transport: null as Error | null }));
vi.mock("@/lib/platforms/registry", async () => {
  const { assertMetaOk } = await import("@/lib/platforms/errors");
  return {
    getProvider: () => ({
      requiresTokenRefresh: () => false,
      refreshBufferSeconds: () => 0,
      sendMessage: async () => {
        if (graph.transport) throw graph.transport;
        await assertMetaOk(new Response(graph.body, { status: graph.status }), "Facebook send message");
        return { platformMessageId: "m_never" };
      },
    }),
  };
});
// Only the channel token is fake; the license token keeps the real crypto.
vi.mock("@/lib/crypto", async (orig) => ({ ...(await orig<typeof import("@/lib/crypto")>()), decryptTokens: () => ({ access_token: "x" }) }));
vi.mock("@/lib/notifications/alert", () => ({ dispatchAlert: async () => {} }));

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_msgfail1_reason_key_0123456789";
const WS = "cccccccc-0000-0000-0000-0000000000f1";
const CH = "cccccccc-0000-0000-0000-0000000000f2";
const CONTACT = "cccccccc-0000-0000-0000-0000000000f3";
const CONV = "cccccccc-0000-0000-0000-0000000000f4";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let GET: typeof import("./route").GET;
let processOutgoingMessage: typeof import("@/lib/workers/outgoing-message-worker").processOutgoingMessage;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ GET } = await import("./route"));
  ({ processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker"));
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  graph.body = "";
  graph.status = 400;
  graph.transport = null;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "F", slug: `f-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-F", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-F" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", last_inbound_at: new Date() });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_msgf" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
});

function manualReply(key: string, text: string) {
  return { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: "PSID-F", content: { text }, isManual: true, idempotencyKey: key };
}
const finalAttempt = { logger: { info: () => {} }, job: { id: "j", attempts: 8, max_attempts: 8 } } as never;

type ApiMessage = { id: string; direction: string; text: string | null; status: string; failure_reason?: string | null };
async function readThread(): Promise<ApiMessage[]> {
  const res = await GET(
    new Request(`http://x/api/v1/conversations/${CONV}/messages`, { headers: { authorization: `Bearer ${RAW_KEY}` } }),
    { params: Promise.resolve({ conversationId: CONV }) },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiMessage[] }).data;
}

describe("GET messages — why an outbound message permanently failed", () => {
  it("returns failed + the platform's refusal for a reply rejected by messaging policy", async () => {
    if (!TEST_DB) return;
    graph.body = '{"error":{"message":"(#10) This message is sent outside of allowed window.","type":"OAuthException","code":10,"error_subcode":2018278,"fbtrace_id":"A1B2C3D4E5"}}';
    await processOutgoingMessage(manualReply("msgfail-policy", "late hello") as never, finalAttempt);
    const [m] = await readThread();
    expect(m).toMatchObject({ direction: "outbound", text: "late hello", status: "failed" });
    expect(m.failure_reason).toBe("Facebook send message: outside the allowed messaging window");
  });

  it("returns the provider error for a reply that failed on every retry", async () => {
    if (!TEST_DB) return;
    graph.body = '{"error":{"message":"(#100) Param recipient[id] must be a valid ID string (e.g. \\"123\\")","type":"OAuthException","code":100,"fbtrace_id":"AbC123"}}';
    await expect(processOutgoingMessage(manualReply("msgfail-final", "never delivered") as never, finalAttempt)).rejects.toThrow();
    const [m] = await readThread();
    expect(m.status).toBe("failed");
    expect(m.failure_reason).toContain("(#100) Param recipient[id] must be a valid ID string");
  });

  it("never exposes a token echoed in the error text", async () => {
    if (!TEST_DB) return;
    graph.transport = new Error("fetch failed: https://graph.facebook.com/v21.0/me/messages?access_token=EAAGsecretTOKEN123&x=1");
    await expect(processOutgoingMessage(manualReply("msgfail-redact", "hi") as never, finalAttempt)).rejects.toThrow();
    const [m] = await readThread();
    expect(m.failure_reason).toContain("access_token=[REDACTED]");
    expect(m.failure_reason).not.toContain("EAAGsecretTOKEN123");
  });

  it("returns the reason on a held reply whose drain replay is refused", async () => {
    if (!TEST_DB) return;
    const [held] = await db.insert(s.messages).values({ conversation_id: CONV, direction: "outbound", text: "parked", status: "held" }).returning({ id: s.messages.id });
    graph.body = '{"error":{"message":"No matching user found","type":"OAuthException","code":100,"error_subcode":2018001,"fbtrace_id":"A1B2C3D4E5"}}';
    await processOutgoingMessage({ ...manualReply("msgfail-drain", "parked"), heldMessageId: held.id } as never, finalAttempt);
    const thread = await readThread();
    expect(thread.map((m) => [m.id, m.status, m.failure_reason])).toEqual([
      [held.id, "failed", "Facebook send message: recipient is permanently unreachable"],
    ]);
  });

  it("returns failure_reason null on messages that did not fail (field always present)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.messages).values([
      { conversation_id: CONV, direction: "inbound", text: "hello", status: "sent", created_at: new Date("2030-01-01T10:00:00Z") },
      { conversation_id: CONV, direction: "outbound", text: "hi back", status: "sent", platform_message_id: "m_ok", created_at: new Date("2030-01-01T10:01:00Z") },
    ]);
    const thread = await readThread();
    expect(thread.map((m) => [m.text, m.status, m.failure_reason])).toEqual([
      ["hello", "sent", null],
      ["hi back", "sent", null],
    ]);
  });
});
