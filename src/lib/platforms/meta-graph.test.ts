import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
process.env.META_APP_ID ??= "111";
process.env.META_APP_SECRET ??= "shh";

let fetchAllManagedPages: typeof import("./meta-graph").fetchAllManagedPages;
let assertMetaGraphHost: typeof import("./meta-graph").assertMetaGraphHost;
let MetaTokenError: typeof import("./meta-token").MetaTokenError;

beforeEach(async () => {
  ({ fetchAllManagedPages, assertMetaGraphHost } = await import("./meta-graph"));
  ({ MetaTokenError } = await import("./meta-token"));
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchAllManagedPages — paginated me/accounts (PSA50 host-guarded)", () => {
  it("follows paging.next across pages and returns every row (managed connection > one page)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ data: [{ id: "1" }, { id: "2" }], paging: { next: "https://graph.facebook.com/v20.0/me/accounts?after=AB" } }))
      .mockResolvedValueOnce(ok({ data: [{ id: "3" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchAllManagedPages<{ id: string }>("USER", "id,name");
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to follow a paging.next URL pointing at a non-Meta host (token-exfil guard)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ data: [{ id: "1" }], paging: { next: "https://evil.example.com/steal?access_token=X" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAllManagedPages("USER", "id")).rejects.toBeInstanceOf(MetaTokenError);
  });

  it("stops at the page cap instead of looping forever on a self-referential next", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ data: [{ id: "x" }], paging: { next: "https://graph.facebook.com/v20.0/me/accounts?after=loop" } }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await fetchAllManagedPages("USER", "id");
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("assertMetaGraphHost accepts graph.facebook.com, rejects http + foreign hosts", () => {
    expect(() => assertMetaGraphHost("https://graph.facebook.com/v20.0/me")).not.toThrow();
    expect(() => assertMetaGraphHost("http://graph.facebook.com/x")).toThrow(MetaTokenError);
    expect(() => assertMetaGraphHost("https://graph.facebook.evil.com/x")).toThrow(MetaTokenError);
  });
});
