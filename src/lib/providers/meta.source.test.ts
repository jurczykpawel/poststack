import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { metaProvider } from "./meta";
import { TokenInvalidError, TransientError } from "./errors";

const APP_ID = "APP123";
const savedAppId = process.env.META_APP_ID;
const savedSecret = process.env.META_APP_SECRET;
beforeAll(() => {
  process.env.META_APP_ID = APP_ID; // PSA10 requires app creds for managed connection
  process.env.META_APP_SECRET = "app-secret";
});
afterAll(() => {
  process.env.META_APP_ID = savedAppId;
  process.env.META_APP_SECRET = savedSecret;
});
afterEach(() => vi.unstubAllGlobals());
const master = { accessToken: "EAAG-master" };

function stub(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe("meta inspectSource", () => {
  it("supportsSources", () => expect(metaProvider.supportsSources?.()).toBe(true));

  it("maps type, data-access window and scopes", async () => {
    stub(200, {
      data: {
        app_id: APP_ID,
        type: "USER",
        user_id: "8931",
        is_valid: true,
        data_access_expires_at: 1788794778,
        scopes: ["pages_show_list", "instagram_content_publish"],
      },
    });
    const info = await metaProvider.inspectSource!(master);
    expect(info.providerAccountId).toBe("8931");
    expect(info.type).toBe("USER");
    expect(info.dataAccessExpiresAt).toBe(new Date(1788794778 * 1000).toISOString());
    expect(info.scopes).toContain("instagram_content_publish");
  });

  it("treats data_access_expires_at 0 as no wall (System User)", async () => {
    stub(200, { data: { app_id: APP_ID, type: "SYSTEM_USER", user_id: "1", is_valid: true, data_access_expires_at: 0 } });
    const info = await metaProvider.inspectSource!(master);
    expect(info.dataAccessExpiresAt).toBeUndefined();
  });

  it("rejects a token belonging to a different app (app_id mismatch) [PSA10]", async () => {
    stub(200, { data: { app_id: "SOME_OTHER_APP", type: "USER", user_id: "9", is_valid: true } });
    await expect(metaProvider.inspectSource!(master)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("refuses without app creds — never echo-introspects the master token [PSA10]", async () => {
    const id = process.env.META_APP_ID;
    try {
      delete process.env.META_APP_ID; // app creds absent
      stub(200, { data: { app_id: APP_ID, type: "USER", user_id: "9", is_valid: true } });
      await expect(metaProvider.inspectSource!(master)).rejects.toBeInstanceOf(TokenInvalidError);
    } finally {
      process.env.META_APP_ID = id;
    }
  });

  it("throws TokenInvalidError on code 190", async () => {
    stub(400, { error: { code: 190, message: "expired" } });
    await expect(metaProvider.inspectSource!(master)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws TokenInvalidError when is_valid is false", async () => {
    stub(200, { data: { type: "USER", user_id: "9", is_valid: false } });
    await expect(metaProvider.inspectSource!(master)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws TransientError on 500", async () => {
    stub(500, { error: { message: "server" } });
    await expect(metaProvider.inspectSource!(master)).rejects.toBeInstanceOf(TransientError);
  });
});

describe("meta enumerateSubAccounts", () => {
  it("returns FB pages + linked IG sub-accounts (IG reuses page token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "p1",
                  name: "Page One",
                  access_token: "PT1",
                  instagram_business_account: { id: "ig1", username: "one" },
                },
                { id: "p2", name: "Page Two", access_token: "PT2" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const subs = await metaProvider.enumerateSubAccounts!(master);
    expect(subs).toHaveLength(3);
    const fb1 = subs.find((s) => s.providerAccountId === "p1")!;
    expect(fb1.metadata).toMatchObject({ subKind: "facebook_page" });
    expect(fb1.token.accessToken).toBe("PT1");
    const ig = subs.find((s) => s.providerAccountId === "ig1")!;
    expect(ig.metadata).toMatchObject({ subKind: "instagram" });
    expect(ig.token.accessToken).toBe("PT1"); // same page token
    expect(ig.displayName).toBe("one");
    expect(subs.every((s) => s.platform === "meta")).toBe(true);
  });

  it("follows paging.next", async () => {
    const pages = [
      {
        data: [{ id: "p1", name: "A", access_token: "T1" }],
        paging: { next: "https://graph.facebook.com/next" },
      },
      { data: [{ id: "p2", name: "B", access_token: "T2" }] },
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(pages[i++]), { status: 200 })),
    );
    const subs = await metaProvider.enumerateSubAccounts!(master);
    expect(subs.map((s) => s.providerAccountId)).toEqual(["p1", "p2"]);
  });

  it("throws TokenInvalidError on code 190", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 190, message: "expired" } }), { status: 400 }),
      ),
    );
    await expect(metaProvider.enumerateSubAccounts!(master)).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
