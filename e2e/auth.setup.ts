import { test as setup, expect } from "@playwright/test";
import { Client } from "pg";
import { createCipheriv, createHash, randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { E2E_DATABASE_URL, serverEnv } from "./env";

const AUTH_FILE = "./e2e/.auth/state.json";
const ADMIN_EMAIL = "admin@e2e.test";
const ADMIN_PASSWORD = "e2e-password-123";

// Mirror src/lib/crypto.ts encryptString (AES-256-GCM, sha256-derived key, iv:tag:ct hex) so seeded
// channel tokens decrypt under the SAME ENCRYPTION_KEY the server boots with.
function encryptString(plaintext: string): string {
  const key = createHash("sha256").update(serverEnv().ENCRYPTION_KEY).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}
function encryptTokens(data: unknown): string {
  return encryptString(JSON.stringify(data));
}

// Register the admin (first user bootstraps the workspace), save the session cookie as storageState,
// then seed real rows directly so each list section renders ≥1 row (not just empty states).
setup("register admin + seed", async ({ request }) => {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });

  const res = await request.post("/register", {
    headers: { "content-type": "application/json" },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: "E2E Admin" },
  });
  // The /register PAGE route answers with an HX-Redirect (204) carrying the session cookie on success;
  // 409 if a prior run already created the admin (DB reset should make this a 204 first-bootstrap).
  expect([204, 201, 409], `register status ${res.status()}: ${await res.text()}`).toContain(res.status());

  // Pull the workspace id (the registration created exactly one).
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const ws = await client.query<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1");
    const workspaceId = ws.rows[0]?.id;
    expect(workspaceId, "registration should have created a workspace").toBeTruthy();

    // A brand (publishing + reply grouping). Composite PK (workspace_id, key).
    await client.query(
      `INSERT INTO brands (workspace_id, key, name, accent, icon)
       VALUES ($1, 'e2e-brand', 'E2E Brand', '#7aa2f7', 'E')
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );

    // One connected channel per platform we can (facebook + instagram + tiktok), status active, with a
    // webhook_secret + encrypted token so channel/inbox/queue lists have rows.
    const platforms: Array<{ platform: string; pid: string; name: string }> = [
      { platform: "facebook", pid: "fb_e2e_1", name: "E2E FB Page" },
      { platform: "instagram", pid: "ig_e2e_1", name: "E2E IG Account" },
      { platform: "tiktok", pid: "tt_e2e_1", name: "E2E TikTok" },
    ];
    for (const p of platforms) {
      await client.query(
        `INSERT INTO channels (workspace_id, platform, platform_id, display_name, username,
            token_encrypted, webhook_secret, status, connection_mode, brand_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'manual_token', 'e2e-brand')
         ON CONFLICT DO NOTHING`,
        [
          workspaceId,
          p.platform,
          p.pid,
          p.name,
          p.name.toLowerCase().replace(/\s+/g, "_"),
          encryptTokens({ accessToken: `e2e-token-${p.pid}` }),
          randomBytes(16).toString("hex"),
        ],
      );
    }

    // A content item + its per-platform post so the Content list shows a row.
    const content = await client.query<{ id: string }>(
      `INSERT INTO content (workspace_id, title, content_type, profile, status, base_description)
       VALUES ($1, 'E2E sample reel', 'reel', 'e2e-brand', 'draft', 'A seeded content item for e2e.')
       RETURNING id`,
      [workspaceId],
    );
    const contentId = content.rows[0].id;
    await client.query(
      `INSERT INTO posts (workspace_id, content_id, platform, status)
       VALUES ($1, $2, 'instagram', 'planned')
       ON CONFLICT DO NOTHING`,
      [workspaceId, contentId],
    );

    // A workspace event so the Events log shows a row.
    await client.query(
      `INSERT INTO events (workspace_id, type, subject_type, subject_id)
       VALUES ($1, 'channel.connected', 'channel', 'fb_e2e_1')`,
      [workspaceId],
    );
  } finally {
    await client.end();
  }

  // Persist the logged-in session for reuse across specs.
  await request.storageState({ path: AUTH_FILE });

  // The app correctly sets the session cookie `Secure` in production (NODE_ENV=production), but the
  // e2e server runs the production build over plain http on loopback — a Secure cookie is never sent
  // over http, so every authenticated request would 401. Strip `secure` from the SAVED state (a
  // test-only transport concession; the cookie value/auth is unchanged).
  const state = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as { cookies: Array<{ secure?: boolean }> };
  for (const c of state.cookies) c.secure = false;
  writeFileSync(AUTH_FILE, JSON.stringify(state));
});
