import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountSources, channels } from "@/db/schema";
import { encryptTokens, decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { GRAPH_API_BASE } from "@/lib/platforms/constants";
import { inspectMetaToken, MetaTokenError, type MetaTokenKind } from "@/lib/platforms/meta-token";
import { dispatchAlert } from "@/lib/notifications/alert";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { redactSecrets } from "@/lib/redact";
import { upsertChannels } from "./upsert";
import { subscribeChannelWebhooks } from "./subscribe";

/**
 * Managed connection ("Meta managed connection", PRO): ONE master Meta token (a long-lived User or a
 * Business-Manager System User token) is stored in `account_sources`, and ALL of its Pages + linked
 * Instagram business accounts are minted as `derived` channels pointing back at that source. A daily
 * sync re-enumerates so newly-added Pages appear automatically; the source carries the ~90-day
 * data-access wall (user tokens) that the expiry cron + UI badge read without decrypting anything.
 *
 * Only "meta" is supported today (Facebook + Instagram share one Graph token).
 */
const PROVIDER = "meta";

interface MasterIdentity {
  id: string;
  name?: string;
}

/** Resolve the account a master token belongs to (its id is the dedup key for the source row). */
async function fetchTokenIdentity(token: string): Promise<MasterIdentity> {
  const res = await fetch(
    `${GRAPH_API_BASE}/me?` + new URLSearchParams({ access_token: token, fields: "id,name" }),
    { redirect: "error", signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new MetaTokenError("Could not read the account this token belongs to — check the token and try again.");
  }
  const data = (await res.json()) as { id?: string; name?: string };
  if (!data.id) {
    throw new MetaTokenError("This token did not resolve to a Meta account. Paste a User or System User token.");
  }
  return { id: data.id, name: data.name };
}

/** Enumerate every Page (Facebook) + linked IG business account behind a master token. */
async function enumerateAll(token: string) {
  const facebook = await getProvider("facebook").connectWithToken!(token);
  const instagram = await getProvider("instagram").connectWithToken!(token);
  return { facebook, instagram };
}

export interface ConnectSourceResult {
  sourceId: string;
  kind: MetaTokenKind;
  connected: number;
  byPlatform: { facebook: number; instagram: number };
}

/**
 * Connect (or re-connect) a managed source from a pasted master token and mint its derived channels.
 * Rejects a PAGE token with a clear message (a page token connects only one page — that's the FREE
 * single-page path, not a managed connection). Idempotent per (workspace, provider, account id).
 */
export async function connectAccountSource(
  workspaceId: string,
  token: string,
): Promise<ConnectSourceResult> {
  const info = await inspectMetaToken(token);
  if (info?.kind === "page") {
    throw new MetaTokenError(
      "A Page token connects only one page. For a managed connection that auto-syncs all your Pages and Instagram accounts, paste a User or System User token.",
    );
  }
  const kind: MetaTokenKind = info?.kind ?? "user";

  const identity = await fetchTokenIdentity(token);
  const { facebook, instagram } = await enumerateAll(token);
  if (facebook.length + instagram.length === 0) {
    throw new MetaTokenError("No Pages or Instagram accounts are accessible with this token.");
  }

  const dataAccessExpiresAt = info?.dataAccessExpiresAt ? new Date(info.dataAccessExpiresAt * 1000) : null;
  const encrypted = encryptTokens({ access_token: token });
  const stamp = {
    display_name: identity.name ?? null,
    kind,
    token_encrypted: encrypted,
    status: "active" as const,
    needs_reauth_reason: null,
    last_error: null,
    data_access_expires_at: dataAccessExpiresAt,
    last_synced_at: new Date(),
    metadata: { scopes: info?.scopes ?? [] },
  };

  const [source] = await db
    .insert(accountSources)
    .values({ workspace_id: workspaceId, provider: PROVIDER, provider_account_id: identity.id, ...stamp })
    .onConflictDoUpdate({
      target: [accountSources.workspace_id, accountSources.provider, accountSources.provider_account_id],
      set: stamp,
    })
    .returning({ id: accountSources.id });

  if (facebook.length > 0) {
    await upsertChannels(workspaceId, "facebook", facebook, {
      connectionMode: "derived",
      sourceId: source.id,
      dataAccessExpiresAt,
    });
    // A managed-connection channel is a FULL dual-capability channel: it publishes AND receives. Mint
    // sets webhook_secret (in upsertChannels); subscribe the inbound webhook too (same path as OAuth).
    await subscribeChannelWebhooks(workspaceId, "facebook", facebook);
  }
  if (instagram.length > 0) {
    await upsertChannels(workspaceId, "instagram", instagram, {
      connectionMode: "derived",
      sourceId: source.id,
      dataAccessExpiresAt,
    });
    await subscribeChannelWebhooks(workspaceId, "instagram", instagram);
  }

  return {
    sourceId: source.id,
    kind,
    connected: facebook.length + instagram.length,
    byPlatform: { facebook: facebook.length, instagram: instagram.length },
  };
}

export interface SyncSourceResult {
  connected: number;
  byPlatform: { facebook: number; instagram: number };
}

/**
 * Re-enumerate a stored source's Pages/IG so newly-added accounts appear and reconnected ones
 * recover. Uses the source's own encrypted master token (no user interaction). On success, bumps
 * last_synced_at and clears any error. Throws on failure so the caller (cron / cascade in a later
 * step) can mark the source needs_reauth.
 */
export async function syncAccountSource(sourceId: string): Promise<SyncSourceResult> {
  const source = await db.query.accountSources.findFirst({
    where: and(eq(accountSources.id, sourceId), eq(accountSources.provider, PROVIDER)),
  });
  if (!source || source.status === "disabled") {
    return { connected: 0, byPlatform: { facebook: 0, instagram: 0 } };
  }

  const token = decryptTokens(source.token_encrypted).access_token;
  const info = await inspectMetaToken(token); // throws MetaTokenError if the master went invalid
  const dataAccessExpiresAt = info?.dataAccessExpiresAt ? new Date(info.dataAccessExpiresAt * 1000) : null;
  const { facebook, instagram } = await enumerateAll(token);

  if (facebook.length > 0) {
    await upsertChannels(source.workspace_id, "facebook", facebook, {
      connectionMode: "derived",
      sourceId: source.id,
      dataAccessExpiresAt,
    });
    // Re-subscribe on every sync so a newly-added Page starts receiving inbound immediately (the
    // subscribe is idempotent on Meta's side).
    await subscribeChannelWebhooks(source.workspace_id, "facebook", facebook);
  }
  if (instagram.length > 0) {
    await upsertChannels(source.workspace_id, "instagram", instagram, {
      connectionMode: "derived",
      sourceId: source.id,
      dataAccessExpiresAt,
    });
    await subscribeChannelWebhooks(source.workspace_id, "instagram", instagram);
  }

  await db
    .update(accountSources)
    .set({
      status: "active",
      needs_reauth_reason: null,
      last_error: null,
      data_access_expires_at: dataAccessExpiresAt,
      last_synced_at: new Date(),
    })
    .where(eq(accountSources.id, source.id));

  return {
    connected: facebook.length + instagram.length,
    byPlatform: { facebook: facebook.length, instagram: instagram.length },
  };
}

/**
 * Flag a master source as needing re-auth (its token went invalid) and CASCADE that state to every
 * active derived child channel, so they stop auto-sending until the one master is reconnected (a
 * single reconnect then recovers them all — see {@link connectAccountSource}). Emits ONE alert scoped
 * to the source instead of one per child (no storm). Only the ok→down transition alerts.
 */
export async function markSourceNeedsReauth(sourceId: string, reason: string): Promise<void> {
  // A2: strip any token/secret echoed back in the failure reason (undici errors carry the Graph URL
  // incl. ?access_token=…) BEFORE it is persisted to needs_reauth_reason / last_error (rendered in
  // the UI + returned by GET /api/v1/channels), cascaded to channels, or emitted in the alert detail.
  const detail = redactSecrets(reason).slice(0, 500);
  const source = await db.query.accountSources.findFirst({
    where: eq(accountSources.id, sourceId),
    columns: { status: true, workspace_id: true, display_name: true },
  });
  if (!source) return;

  await db
    .update(accountSources)
    .set({ status: "needs_reauth", needs_reauth_reason: detail, last_error: detail })
    .where(eq(accountSources.id, sourceId));

  // Cascade to the children: pause the active derived channels (leave paused/disabled as the
  // operator set them). They recover in one shot when the master is reconnected.
  await db
    .update(channels)
    .set({ status: "needs_reauth", last_error: detail, last_health_at: new Date() })
    .where(and(eq(channels.source_id, sourceId), eq(channels.status, "active")));

  // One alert per outage (the master is the unit of failure here), only on the ok→down edge.
  if (source.status !== "needs_reauth") {
    await dispatchAlert({
      type: "channel_reauth",
      sourceId,
      workspaceId: source.workspace_id,
      displayName: source.display_name,
      detail: `Managed connection needs re-authentication: ${detail}`,
    });
  }
}

/**
 * Daily sweep: re-enumerate every active managed source so newly-added Pages/IG appear and a
 * reconnected master recovers. Each source is isolated — one failing master is marked needs_reauth
 * and the sweep moves on, never aborting the others (which would silently stop discovering new pages
 * across the whole instance). Returns per-source outcomes for observability.
 */
export async function sweepAccountSources(): Promise<{ synced: number; failed: number }> {
  const sources = await db.query.accountSources.findMany({
    where: eq(accountSources.status, "active"),
    columns: { id: true },
  });

  let synced = 0;
  let failed = 0;
  for (const { id } of sources) {
    try {
      await syncAccountSource(id);
      synced++;
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      await markSourceNeedsReauth(id, reason).catch(() => {});
      console.error(`[source-sync-sweep] source ${id} failed: ${sanitizeForLog(reason)}`);
    }
  }
  return { synced, failed };
}
