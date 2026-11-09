// Scoped Insights fixture: one Instagram channel with locally stored account observations, created
// in the e2e workspace and removed afterwards (observations and the connection cascade with it).
// Values mirror the shape the worker stores (decimal strings, provider days in the connector's
// zone); nothing here is fetched from or sent to the platform.
import { Client } from "pg";
import { createCipheriv, createHash, createHmac, randomBytes } from "crypto";
import { E2E_DATABASE_URL, serverEnv } from "../env";

const ZONE = "America/Los_Angeles";
const DAY = 86400000;
const USER_TOKEN = "e2e-insights-user-token";

/** Same format as src/lib/crypto.ts encryptTokens, under the server's ENCRYPTION_KEY. */
function encryptTokens(data: unknown): string {
  const key = createHash("sha256").update(serverEnv().ENCRYPTION_KEY).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), enc.toString("hex")].join(":");
}

/** Same derivation as src/lib/insights/credentials.ts insightCredentialRevision. */
function revision(transport: string, token: string): string {
  return createHmac("sha256", serverEnv().ENCRYPTION_KEY).update(JSON.stringify(["insights-v1", transport, token])).digest("hex");
}

/** Provider day `offset` days from today in the connector's zone. */
export function providerDay(offset: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
}

function dayStart(day: string): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  const midnight = Date.parse(`${day}T00:00:00Z`);
  return new Date(midnight - offset(midnight - offset(midnight)));
}

/** Daily reach by day offset; a missing offset is a day without data, "0" is a stored zero. */
export const REACH: Record<number, string> = {
  [-30]: "820", [-29]: "910", [-28]: "1040", [-27]: "760", [-26]: "880", [-25]: "1310", [-24]: "1190", [-23]: "990",
  [-22]: "1020", [-21]: "1480", [-20]: "1260", [-19]: "1105", [-18]: "970", [-17]: "1210", [-16]: "1380", [-15]: "1550",
  [-14]: "1300", [-13]: "1170", [-12]: "1420", [-11]: "1610", [-10]: "1290", [-9]: "1335", [-8]: "1460",
  [-7]: "1504", [-6]: "1188", [-5]: "0", /* -4 missing */ [-3]: "1712", [-2]: "2140", [-1]: "1320",
};

export type InsightsFixture = { channelId: string; cleanup: () => Promise<void> };

/** What the stored connection looks like. Defaults describe a healthy, recently synced channel with data. */
export type SeedOptions = {
  state?: "ready" | "missing_permission" | "unknown";
  mode?: "on" | "off";
  reason?: string;
  /** Hours since the last successful sync; null = never synced. */
  lastSuccessHoursAgo?: number | null;
  lastAttemptMinutesAgo?: number;
  /** Provider backoff / quota hold: minutes until the next attempt. */
  backoffInMinutes?: number;
  withData?: boolean;
};

export async function seedInsights(options: "ready" | "missing_permission" | SeedOptions = {}): Promise<InsightsFixture> {
  const opts: SeedOptions = typeof options === "string" ? { state: options } : options;
  const state = opts.state ?? "ready";
  const lastSuccessHoursAgo = opts.lastSuccessHoursAgo === undefined ? 2 : opts.lastSuccessHoursAgo;
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ws] } = await db.query<{ workspace_id: string }>("SELECT workspace_id FROM channels WHERE platform_id = 'fb_e2e_1'");
  const platformId = `ig_insights_e2e_${randomBytes(4).toString("hex")}`;
  const { rows: [channel] } = await db.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, platform, platform_id, display_name, username, token_encrypted, webhook_secret, status, connection_mode, brand_key)
     VALUES ($1, 'instagram', $2, 'Insights Studio', 'insights_studio', $3, $4, 'active', 'oauth', 'e2e-brand') RETURNING id`,
    [ws.workspace_id, platformId, encryptTokens({ access_token: "e2e-insights-page-token", user_access_token: USER_TOKEN }), randomBytes(16).toString("hex")],
  );
  const now = Date.now();
  const lastSuccess = lastSuccessHoursAgo === null ? null : new Date(now - lastSuccessHoursAgo * 3600000);
  const lastAttempt = opts.lastAttemptMinutesAgo === undefined ? null : new Date(now - opts.lastAttemptMinutesAgo * 60000);
  const backoff = opts.backoffInMinutes === undefined ? null : new Date(now + opts.backoffInMinutes * 60000);
  const reason = opts.reason ?? (state === "ready" ? "none" : state === "missing_permission" ? "permission_required" : "first_sync");
  await db.query(
    `INSERT INTO insight_connections (workspace_id, channel_id, platform, collection_mode, access_state, transport, credential_revision, reason,
       last_success_at, last_attempt_at, backoff_until, access_checked_at)
     VALUES ($1, $2, 'instagram', $3, $4, 'facebook', $5, $6, $7, $8, $9, $10)`,
    [ws.workspace_id, channel.id, opts.mode ?? "on", state, revision("facebook", USER_TOKEN), reason, lastSuccess, lastAttempt, backoff, state === "unknown" ? null : lastSuccess ?? new Date(now)],
  );
  for (const [offset, value] of Object.entries(opts.withData === false ? {} : REACH)) {
    const day = providerDay(Number(offset));
    const next = providerDay(Number(offset) + 1);
    await db.query(
      `INSERT INTO insight_observations (workspace_id, channel_id, platform, metric_key, level, subject_key, grain, period, metric_type,
         window_start, window_end, provider_day, boundary_basis, snapshot_day, fetched_at, scalar, response_state, transport, api_version,
         definition_version, coverage_basis, query_key)
       VALUES ($1, $2, 'instagram', 'reach', 'account', $3, 'day', 'day', 'time_series', $4, $5, $6, 'provider_end_time', $6, $7, $8, 'available',
         'facebook', 'v26.0', 'instagram-reach-v1', 'provider_end_time', $9)`,
      [ws.workspace_id, channel.id, platformId, dayStart(day), dayStart(next), day, lastSuccess ?? new Date(now - 2 * 3600000), value, createHash("sha256").update(`e2e-reach-${day}`).digest("hex")],
    );
  }
  return {
    channelId: channel.id,
    cleanup: async () => {
      await db.query("DELETE FROM graphile_worker._private_jobs WHERE payload->>'channelId' = $1", [channel.id]);
      await db.query("DELETE FROM channels WHERE id = $1", [channel.id]);
      await db.end();
    },
  };
}
