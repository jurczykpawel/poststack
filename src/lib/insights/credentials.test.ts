import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptTokens } from "@/lib/crypto";
import { resolveInsightCredential, insightCredentialRevision } from "./credentials";
const { channelLookup, sourceLookup } = vi.hoisted(() => ({ channelLookup: vi.fn(), sourceLookup: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { query: { channels: { findFirst: channelLookup }, accountSources: { findFirst: sourceLookup } } } }));
process.env.ENCRYPTION_KEY = "insights-test-encryption-key-32-characters";
const ref = { workspaceId: "workspace", channelId: "channel" };
function channel(blob: Record<string, unknown>, metadata: Record<string, unknown> = {}, sourceId: string | null = null) {
  return { id: ref.channelId, workspace_id: ref.workspaceId, platform: "instagram", platform_id: "account", token_encrypted: encryptTokens({ access_token: "", ...blob }), metadata, source_id: sourceId, status: "active" };
}
beforeEach(() => { vi.clearAllMocks(); sourceLookup.mockResolvedValue(undefined); });
describe("insights credential selection", () => {
  it("uses an Instagram User token and never treats a Page token as a User token", async () => {
    channelLookup.mockResolvedValue(channel({ messaging_token: "ig-user" }));
    expect(await resolveInsightCredential(ref, null)).toMatchObject({ transport: "instagram_business", token: "ig-user" });
    channelLookup.mockResolvedValue(channel({ access_token: "page" }));
    expect(await resolveInsightCredential(ref, null)).toBeNull();
  });
  it("selects the requested User token on dual channels without fallback", async () => {
    channelLookup.mockResolvedValue(channel({ messaging_token: "ig-user", user_access_token: "fb-user", access_token: "page" }));
    expect(await resolveInsightCredential(ref, "facebook")).toMatchObject({ transport: "facebook", token: "fb-user" });
    expect(await resolveInsightCredential(ref, "instagram_business")).toMatchObject({ transport: "instagram_business", token: "ig-user" });
    channelLookup.mockResolvedValue(channel({ access_token: "page" }));
    expect(await resolveInsightCredential(ref, "facebook")).toBeNull();
  });
  it("prefers token-bound evidence and ignores unrelated granted_scopes", async () => {
    const revision = insightCredentialRevision("instagram_business", "ig-user");
    channelLookup.mockResolvedValue(channel({ messaging_token: "ig-user", user_access_token: "fb-user" }, {
      granted_scopes: ["instagram_manage_insights"], insights_credentials: { instagram_business: { revision, state: "ready" } },
    }));
    expect((await resolveInsightCredential(ref, null))?.transport).toBe("instagram_business");
    channelLookup.mockResolvedValue(channel({ messaging_token: "new-ig", user_access_token: "fb-user" }, {
      granted_scopes: ["instagram_business_manage_insights"], insights_credentials: { instagram_business: { revision, state: "ready" } },
    }));
    expect((await resolveInsightCredential(ref, null))?.transport).toBe("facebook");
  });
  it("uses only active workspace Meta User sources and shares their budget", async () => {
    channelLookup.mockResolvedValue(channel({}, {}, "source"));
    const source = { id: "source", workspace_id: "workspace", provider: "meta", kind: "user", status: "active", provider_account_id: "user", token_encrypted: encryptTokens({ access_token: "source-user" }) };
    sourceLookup.mockResolvedValue(source);
    expect(await resolveInsightCredential(ref, null)).toMatchObject({ transport: "facebook", token: "source-user" });
    const { where } = sourceLookup.mock.calls[0][0]; expect(where).toBeDefined();
    for (const over of [{ workspace_id: "other" }, { provider: "other" }, { kind: "system_user" }, { status: "disabled" }]) {
      sourceLookup.mockResolvedValue({ ...source, ...over });
      expect(await resolveInsightCredential(ref, null)).toBeNull();
    }
  });
  it("does not return corrupt or cross-workspace credentials", async () => {
    channelLookup.mockResolvedValue({ ...channel({ messaging_token: "ig" }), workspace_id: "other" });
    expect(await resolveInsightCredential(ref, null)).toBeNull();
    channelLookup.mockResolvedValue({ ...channel({ messaging_token: "ig" }), token_encrypted: "invalid" });
    expect(await resolveInsightCredential(ref, null)).toBeNull();
  });
});

it("keeps an Instagram credential when the source credential cannot be read", async () => {
  channelLookup.mockResolvedValue(channel({ messaging_token: "ig-user" }, {}, "source"));
  sourceLookup.mockResolvedValue({ id: "source", workspace_id: "workspace", provider: "meta", kind: "user", status: "active", provider_account_id: "user", token_encrypted: "invalid" });
  expect(await resolveInsightCredential(ref, null)).toMatchObject({ transport: "instagram_business", token: "ig-user" });
});
