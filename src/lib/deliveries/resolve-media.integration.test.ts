import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let resolveMedia: typeof import("./resolve-media").resolveMedia;
let PermanentError: typeof import("@/lib/providers/errors").PermanentError;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ resolveMedia } = await import("./resolve-media"));
  ({ PermanentError } = await import("@/lib/providers/errors"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `resolve-media-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
});

describe("resolveMedia", () => {
  it("maps media ids to their public urls in order", async () => {
    if (!TEST_DB) return;
    const [a] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `a${Math.random()}`, storage_key: "ka", url: "https://cdn/a.mp4", kind: "video" })
      .returning();
    const [b] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `b${Math.random()}`, storage_key: "kb", url: "https://cdn/b.mp4", kind: "video" })
      .returning();
    expect(await resolveMedia([{ mediaId: b!.id }, { mediaId: a!.id }], WS)).toEqual([
      "https://cdn/b.mp4",
      "https://cdn/a.mp4",
    ]);
  });

  it("throws PermanentError when a referenced media is gone", async () => {
    if (!TEST_DB) return;
    await expect(
      resolveMedia([{ mediaId: "00000000-0000-0000-0000-000000000000" }], WS),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("a media id belonging to another workspace resolves as not found (tenancy)", async () => {
    if (!TEST_DB) return;
    const WS2 = await seedWorkspace(db, schema, { slug: `resolve-media2-${Date.now()}` });
    const [other] = await db
      .insert(schema.media)
      .values({ workspace_id: WS2, checksum: `o${Math.random()}`, storage_key: "ko", url: "https://cdn/o.mp4", kind: "video" })
      .returning();
    await expect(resolveMedia([{ mediaId: other!.id }], WS)).rejects.toBeInstanceOf(PermanentError);
    await db.delete(schema.media).where(eq(schema.media.workspace_id, WS2));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
  });
});
