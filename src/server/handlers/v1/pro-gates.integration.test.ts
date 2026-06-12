import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";
import type { ConnectedAccount } from "@/lib/platforms/base";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "rs_live_progates_0123456789abcdef0123456789abcdef";
const WS = "9b500000-0000-0000-0000-0000000000b1";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let seqs: typeof import("./sequences/route");
let contactsList: typeof import("./contacts/route");
let contact: typeof import("./contacts/[contactId]/route");
let conversationsList: typeof import("./conversations/route");
let tagsRoute: typeof import("./tags/route");
let assertChannelsAllowed: typeof import("@/lib/channels/upsert").assertChannelsAllowed;
let ProRequiredError: typeof import("@/lib/license/gate").ProRequiredError;
let gate: typeof import("@/lib/license/gate");

const CONTACT = "9b500000-0000-0000-0000-0000000000c9";
const get = (path = "http://x") => new Request(path, { headers: { authorization: `Bearer ${KEY}` } });
const del = () => new Request("http://x", { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } });
const params = (contactId: string) => ({ params: Promise.resolve({ contactId }) });

const account = (platformId: string): ConnectedAccount =>
  ({ platformId, displayName: "Acct", tokens: { access_token: "t" } }) as ConnectedAccount;

const seqPost = (body: unknown) =>
  new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const aSequence = { name: "Drip", steps: [{ type: "delay", delay_minutes: 60 }, { type: "message", content: "hi" }] };

async function seedChannel(platform: string, platformId: string) {
  await db.insert(s.channels).values({
    workspace_id: WS, platform: platform as "facebook", platform_id: platformId,
    token_encrypted: "x", webhook_secret: "s", status: "active",
  });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  seqs = await import("./sequences/route");
  contactsList = await import("./contacts/route");
  contact = await import("./contacts/[contactId]/route");
  conversationsList = await import("./conversations/route");
  tagsRoute = await import("./tags/route");
  ({ assertChannelsAllowed } = await import("@/lib/channels/upsert"));
  ({ ProRequiredError } = gate = await import("@/lib/license/gate"));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "PGate", slug: `pgate-${WS}` });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "rs_live_progates" });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  await db.delete(s.sequences).where(eq(s.sequences.workspace_id, WS));
  await db.delete(s.contacts).where(eq(s.contacts.workspace_id, WS));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

describe("channel gate (free tier: one FB + one IG, nothing else)", () => {
  it("allows the first Facebook channel", async () => {
    if (!TEST_DB) return;
    await expect(assertChannelsAllowed(WS, "facebook", [account("FB1")])).resolves.toBeUndefined();
  });

  it("blocks a Telegram channel without a license (non_meta_channels)", async () => {
    if (!TEST_DB) return;
    await expect(assertChannelsAllowed(WS, "telegram", [account("TG1")])).rejects.toMatchObject({ feature: "non_meta_channels" });
    await expect(assertChannelsAllowed(WS, "telegram", [account("TG1")])).rejects.toBeInstanceOf(ProRequiredError);
  });

  it("blocks a 2nd Facebook channel without a license (multi_channel)", async () => {
    if (!TEST_DB) return;
    await seedChannel("facebook", "FB1");
    await expect(assertChannelsAllowed(WS, "facebook", [account("FB2")])).rejects.toMatchObject({ feature: "multi_channel" });
  });

  it("allows reconnecting an already-connected channel (same platform_id)", async () => {
    if (!TEST_DB) return;
    await seedChannel("facebook", "FB1");
    await expect(assertChannelsAllowed(WS, "facebook", [account("FB1")])).resolves.toBeUndefined();
  });

  it("allows everything once licensed", async () => {
    if (!TEST_DB) return;
    await seedChannel("facebook", "FB1");
    await licenseInstance();
    await expect(assertChannelsAllowed(WS, "telegram", [account("TG1")])).resolves.toBeUndefined();
    await expect(assertChannelsAllowed(WS, "facebook", [account("FB2")])).resolves.toBeUndefined();
  });
});

describe("sequences gate", () => {
  it("blocks creating a sequence without a license (402)", async () => {
    if (!TEST_DB) return;
    const res = await seqs.POST(seqPost(aSequence));
    expect(res.status).toBe(402);
    expect((await res.json()).error.details.feature).toBe("sequences");
  });

  it("allows creating a sequence when licensed (201)", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const res = await seqs.POST(seqPost(aSequence));
    expect(res.status).toBe(201);
  });
});

describe("contacts/inbox visibility gate (contacts_crm)", () => {
  it("blocks reading the contacts list without a license (402)", async () => {
    if (!TEST_DB) return;
    const res = await contactsList.GET(get());
    expect(res.status).toBe(402);
    expect((await res.json()).error.details.feature).toBe("contacts_crm");
  });

  it("blocks reading the conversations list without a license (402)", async () => {
    if (!TEST_DB) return;
    const res = await conversationsList.GET(get());
    expect(res.status).toBe(402);
    expect((await res.json()).error.details.feature).toBe("contacts_crm");
  });

  it("blocks reading and creating tags without a license (402)", async () => {
    if (!TEST_DB) return;
    expect((await tagsRoute.GET(get())).status).toBe(402);
    const post = new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ name: "VIP" }) });
    expect((await tagsRoute.POST(post)).status).toBe(402);
  });

  it("keeps GDPR contact erasure free (DELETE is never gated)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS, display_name: "Erase me" });
    const res = await contact.DELETE(del(), params(CONTACT));
    expect(res.status).not.toBe(402);
    const gone = await db.query.contacts.findFirst({ where: eq(s.contacts.id, CONTACT), columns: { id: true } });
    expect(gone).toBeUndefined();
  });

  it("unlocks the contacts list once licensed (200)", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const res = await contactsList.GET(get());
    expect(res.status).toBe(200);
  });
});
