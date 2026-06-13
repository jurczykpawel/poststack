import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountSources } from "@/db/schema";
import { encryptTokens, decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { GRAPH_API_BASE } from "@/lib/platforms/constants";
import { inspectMetaToken, MetaTokenError, type MetaTokenKind } from "@/lib/platforms/meta-token";
import { upsertChannels } from "./upsert";

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
  }
  if (instagram.length > 0) {
    await upsertChannels(workspaceId, "instagram", instagram, {
      connectionMode: "derived",
      sourceId: source.id,
      dataAccessExpiresAt,
    });
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
  }
  if (instagram.length > 0) {
    await upsertChannels(source.workspace_id, "instagram", instagram, {
      connectionMode: "derived",
      sourceId: source.id,
      dataAccessExpiresAt,
    });
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
