// Workspace-scoped channel read/aggregation + mutation service for the unified Channels admin
// section (UNIFY1 Phase 3 Task 1). This is the ONE read/aggregation layer the channels UI calls;
// it WRAPS the existing trunk primitives (upsert, drain, health, rate-limit, providers) rather than
// duplicating their logic, and EVERY function takes `workspaceId` and scopes by it.
//
// PublicChannel is the UI-facing projection of a channel row. It exposes `provider_account_id`
// (= the row's `platform_id`) so the ported PostStack section markup reads naturally; capabilities
// are computed (never stored) via channels/capabilities.
import { and, asc, desc, eq, isNull, isNotNull, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, channelRateState, type Platform } from "@/db/schema";
import { getProvider } from "@/lib/platforms/registry";
import { MetaTokenError, inspectMetaToken } from "@/lib/platforms/meta-token";
import { decryptTokens } from "@/lib/crypto";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { markChannelHealthy, markChannelNeedsReauth } from "@/lib/channels/health";
import { reconcileChannelSubscription, isSubscribablePlatform } from "@/lib/channels/subscription-status";
import { messagingConnection, type MessagingConnection } from "@/lib/channels/ig-connection";
import { ApiError } from "@/lib/api/response";

const META_HEALTH_PLATFORMS = new Set(["facebook", "instagram"]);

export type ChannelStatus = "active" | "needs_reauth" | "paused" | "disabled";
const CHANNEL_STATUSES: ChannelStatus[] = ["active", "needs_reauth", "paused", "disabled"];

export type AiDraftTarget = "dm" | "public" | "both";
const AI_DRAFT_TARGETS: AiDraftTarget[] = ["dm", "public", "both"];
export function isAiDraftTarget(v: string | undefined): v is AiDraftTarget {
  return !!v && (AI_DRAFT_TARGETS as string[]).includes(v);
}

export type ChannelSort = "recent" | "name" | "status" | "platform";
const CHANNEL_SORTS: ChannelSort[] = ["recent", "name", "status", "platform"];
export function isChannelSort(v: string | undefined): v is ChannelSort {
  return !!v && (CHANNEL_SORTS as string[]).includes(v);
}

/** UI projection of a channel. `provider_account_id` aliases the row's `platform_id`. */
export interface PublicChannel {
  id: string;
  platform: string;
  provider_account_id: string;
  display_name: string | null;
  username: string | null;
  profile_picture: string | null;
  status: ChannelStatus;
  connection_mode: "oauth" | "manual_token" | "derived";
  brand_key: string | null;
  source_id: string | null;
  token_expires_at: Date | null;
  data_access_expires_at: Date | null;
  needs_reauth_reason: string | null;
  hidden_at: Date | null;
  /** FIRSTCOMMENT1: default first-comment text auto-posted under posts published to this channel. */
  default_first_comment: string | null;
  /** STORY1: when true, every post published to this channel also auto-publishes a Story card. */
  default_auto_story: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  /** Gmail-channel ingest filter (raw Gmail query string). NULL = use default "in:inbox". */
  gmail_query: string | null;
  /** Last error recorded against this channel (e.g. token/health failure), or null. */
  last_error: string | null;
  /** IGML3: Instagram-Login messaging token expiry (set only on IG-Login channels), or null. */
  messaging_token_expires_at: Date | null;
  /** Derived IG messaging credential shape (instagram_login / facebook_only); null for non-IG. */
  messaging_connection: MessagingConnection | null;
  /** AIDRAFT1: when true, the inbound pipeline drafts an AI reply for matching activity on this channel. */
  ai_draft_enabled: boolean;
  /** AIDRAFT1: which surface AI drafting applies to (dm / public comments / both). */
  ai_draft_target: AiDraftTarget;
  /** ADPROMPT2: per-channel DM-reply prompt override; null inherits the workspace default. */
  ai_draft_prompt_dm: string | null;
  /** ADPROMPT2: per-channel public-comment-reply prompt override; null inherits the workspace default. */
  ai_draft_prompt_public: string | null;
  /** AIDRAFT1: send a high-confidence DM draft without manual approval (advanced). */
  ai_draft_autosend_dm: boolean;
  /** AIDRAFT1: send a high-confidence public-comment draft without manual approval (advanced). */
  ai_draft_autosend_public: boolean;
}

type ChannelRow = typeof channels.$inferSelect;
export function toPublic(r: ChannelRow): PublicChannel {
  return {
    id: r.id,
    platform: r.platform,
    provider_account_id: r.platform_id,
    display_name: r.display_name,
    username: r.username,
    profile_picture: r.profile_picture,
    status: r.status as ChannelStatus,
    connection_mode: r.connection_mode,
    brand_key: r.brand_key,
    source_id: r.source_id,
    token_expires_at: r.token_expires_at,
    data_access_expires_at: r.data_access_expires_at,
    needs_reauth_reason: r.needs_reauth_reason,
    hidden_at: r.hidden_at,
    default_first_comment: r.default_first_comment,
    default_auto_story: r.default_auto_story,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    created_at: r.created_at,
    gmail_query: r.gmail_query,
    last_error: r.last_error ?? null,
    messaging_token_expires_at: r.messaging_token_expires_at ?? null,
    messaging_connection: messagingConnection({ platform: r.platform, messaging_token_expires_at: r.messaging_token_expires_at ?? null }),
    ai_draft_enabled: r.ai_draft_enabled,
    ai_draft_target: r.ai_draft_target as AiDraftTarget,
    ai_draft_prompt_dm: r.ai_draft_prompt_dm,
    ai_draft_prompt_public: r.ai_draft_prompt_public,
    ai_draft_autosend_dm: r.ai_draft_autosend_dm,
    ai_draft_autosend_public: r.ai_draft_autosend_public,
  };
}

export interface ListChannelsArgs {
  workspaceId: string;
  limit?: number;
  platform?: string;
  /** Reserved for Meta subKind filtering; RS stores facebook/instagram as distinct platforms,
   *  so this is accepted for API parity but folded into `platform` when present. */
  subKind?: string;
  status?: ChannelStatus;
  q?: string;
  sort?: ChannelSort;
  sourceId?: string;
  showHidden?: boolean;
}

export interface ListChannelsResult {
  items: PublicChannel[];
  countsByPlatform: Record<string, number>;
  countsByStatus: Record<ChannelStatus, number>;
  hiddenCount: number;
}

const ORDER = {
  recent: desc(channels.created_at),
  name: asc(channels.display_name),
  status: asc(channels.status),
  platform: asc(channels.platform),
} as const;

/**
 * List a workspace's channels with the filters + the counts headers the UI needs. The status/
 * platform counts and hiddenCount are computed over the workspace's NON-deleted channels (ignoring
 * the status/platform/q filters) so the chips always show the full breakdown to filter BY.
 */
export async function listChannels(args: ListChannelsArgs): Promise<ListChannelsResult> {
  const { workspaceId } = args;
  // `subKind` (facebook_page / instagram) maps onto the RS platform column when no explicit platform.
  let platform = args.platform;
  if (!platform && args.subKind === "facebook_page") platform = "facebook";
  if (!platform && args.subKind === "instagram") platform = "instagram";

  const base = [eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)];

  // Counts over all non-deleted channels in the workspace (independent of the row filters).
  const allRows = await db.query.channels.findMany({
    where: and(...base),
    columns: { platform: true, status: true, hidden_at: true },
  });
  const countsByStatus = { active: 0, needs_reauth: 0, paused: 0, disabled: 0 } as Record<ChannelStatus, number>;
  const countsByPlatform: Record<string, number> = {};
  let hiddenCount = 0;
  for (const r of allRows) {
    countsByStatus[r.status as ChannelStatus]++;
    countsByPlatform[r.platform] = (countsByPlatform[r.platform] ?? 0) + 1;
    if (r.hidden_at) hiddenCount++;
  }

  const where = [...base];
  // The "Hidden" chip is a filter like status/platform: showHidden lists ONLY hidden channels;
  // the default list shows only non-hidden ones.
  where.push(args.showHidden ? isNotNull(channels.hidden_at) : isNull(channels.hidden_at));
  if (platform) where.push(eq(channels.platform, platform as Platform));
  if (args.status) where.push(eq(channels.status, args.status));
  if (args.sourceId) where.push(eq(channels.source_id, args.sourceId));
  if (args.q) {
    const like = `%${args.q}%`;
    where.push(or(ilike(channels.display_name, like), ilike(channels.platform_id, like), ilike(channels.username, like))!);
  }

  const sort = args.sort && isChannelSort(args.sort) ? args.sort : "recent";
  const rows = await db.query.channels.findMany({
    where: and(...where),
    orderBy: ORDER[sort],
    limit: args.limit ?? 100,
  });

  return { items: rows.map(toPublic), countsByPlatform, countsByStatus, hiddenCount };
}

/** A single channel by id, scoped to the workspace (non-deleted). */
export async function getChannel(workspaceId: string, id: string): Promise<PublicChannel | undefined> {
  const r = await db.query.channels.findFirst({
    where: and(eq(channels.id, id), eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)),
  });
  return r ? toPublic(r) : undefined;
}

/** The channel's rate-limit bucket state (tokens left + last refill), or undefined if untracked. */
export async function getChannelRateState(
  workspaceId: string,
  id: string,
): Promise<{ tokens: number; updatedAt: Date } | undefined> {
  // Scope the bucket lookup through the owning channel so a cross-workspace id can't read it.
  const ch = await db.query.channels.findFirst({
    where: and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)),
    columns: { id: true },
  });
  if (!ch) return undefined;
  const rate = await db.query.channelRateState.findFirst({ where: eq(channelRateState.channel_id, id) });
  return rate ? { tokens: rate.tokens, updatedAt: rate.updated_at } : undefined;
}

// ── mutations (all workspace-scoped) ──────────────────────────────────────────────────────────

/** Resolve a workspace-owned, non-deleted channel id or throw 404 (so mutations never touch another
 *  workspace's row). */
async function ownChannelOr404(workspaceId: string, id: string): Promise<ChannelRow> {
  const r = await db.query.channels.findFirst({
    where: and(eq(channels.id, id), eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)),
  });
  if (!r) throw new ApiError("not_found", "Channel not found", 404);
  return r;
}

/** Connect a channel (or several, for Meta) from a pasted long-lived / System User token. */
export async function connectManualToken(
  workspaceId: string,
  input: { platform: string; token: string },
): Promise<{ connected: number }> {
  if (input.platform !== "facebook" && input.platform !== "instagram") {
    throw new ApiError("invalid_request", "Manual token connect supports facebook / instagram", 400);
  }
  const provider = getProvider(input.platform as Platform);
  if (!provider.connectWithToken) {
    throw new ApiError("invalid_request", "Platform does not support manual token connection", 400);
  }
  let accounts;
  try {
    accounts = await provider.connectWithToken(input.token);
  } catch (err) {
    if (err instanceof MetaTokenError) throw new ApiError("invalid_request", err.message, 400);
    throw new ApiError("invalid_request", "Token validation failed — check the token and its permissions", 400);
  }
  if (accounts.length === 0) throw new ApiError("invalid_request", "No pages or accounts are accessible with this token", 400);
  await assertChannelsAllowed(workspaceId, input.platform as Platform, accounts);
  await upsertChannels(workspaceId, input.platform as Platform, accounts, { connectionMode: "manual_token" });
  return { connected: accounts.length };
}

/** Reconnect a manual-token channel by pasting a fresh token (re-validates + re-upserts). */
export async function reconnectManualToken(workspaceId: string, id: string, token: string): Promise<void> {
  const ch = await ownChannelOr404(workspaceId, id);
  if (ch.connection_mode !== "manual_token") {
    throw new ApiError("invalid_request", "This channel does not reconnect via a pasted token", 400);
  }
  await connectManualToken(workspaceId, { platform: ch.platform, token });
}

/** Set a channel's operational status (paused / active / disabled). Healthy→active drains held. */
export async function setChannelStatus(workspaceId: string, id: string, status: ChannelStatus): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  if (status === "active") {
    // Route through the health helper so a needs_reauth→active recovery enqueues the drain.
    await markChannelHealthy(id);
    return;
  }
  await db.update(channels).set({ status }).where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** Rename a channel (display name only). */
export async function setChannelDisplayName(workspaceId: string, id: string, displayName: string): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  const name = displayName.trim().slice(0, 200);
  await db.update(channels).set({ display_name: name || null }).where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** FIRSTCOMMENT1: set (or clear) the default first-comment auto-posted under this channel's posts.
 *  Empty / whitespace clears it (NULL = off). Capped to keep within platform comment limits. */
export async function setChannelDefaultFirstComment(workspaceId: string, id: string, text: string): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  const trimmed = text.trim().slice(0, 2000);
  await db
    .update(channels)
    .set({ default_first_comment: trimmed || null })
    .where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** STORY1: enable / disable the per-channel default auto-Story (a generated Story card published
 *  about every post). The per-post `autoStory` on the publish request overrides this. */
export async function setChannelDefaultAutoStory(workspaceId: string, id: string, enabled: boolean): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  await db
    .update(channels)
    .set({ default_auto_story: enabled })
    .where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** AIDRAFT1/ADPROMPT2: per-channel AI-draft settings. Workspace-scoped (404 on a foreign id). A
 *  blank prompt override stores NULL (= inherit the matching workspace default). The two prompt
 *  overrides are independent (DM vs public comment reply). The two auto-send flags bypass approval. */
export interface AiDraftChannelSettings {
  enabled: boolean;
  target: AiDraftTarget;
  promptDm: string;
  promptPublic: string;
  autosendDm: boolean;
  autosendPublic: boolean;
}
export async function setChannelAiDraftSettings(
  workspaceId: string,
  id: string,
  settings: AiDraftChannelSettings,
): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  await db
    .update(channels)
    .set({
      ai_draft_enabled: settings.enabled,
      ai_draft_target: settings.target,
      ai_draft_prompt_dm: settings.promptDm.trim().slice(0, 4000) || null,
      ai_draft_prompt_public: settings.promptPublic.trim().slice(0, 4000) || null,
      ai_draft_autosend_dm: settings.autosendDm,
      ai_draft_autosend_public: settings.autosendPublic,
    })
    .where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** Hide / unhide a channel (stays connected, filtered out of the default list). */
export async function setChannelHidden(workspaceId: string, id: string, hidden: boolean): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  await db.update(channels).set({ hidden_at: hidden ? new Date() : null }).where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** Save the Gmail ingest filter query for a Gmail channel. Empty string clears it (reverts to default). */
export async function setChannelGmailQuery(workspaceId: string, id: string, query: string): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  await db
    .update(channels)
    .set({ gmail_query: query || null })
    .where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/** Soft-delete a channel (row kept, excluded from every read). */
export async function deleteChannel(workspaceId: string, id: string): Promise<void> {
  await ownChannelOr404(workspaceId, id);
  await db.update(channels).set({ deleted_at: new Date(), status: "disabled" }).where(and(eq(channels.id, id), eq(channels.workspace_id, workspaceId)));
}

/**
 * Run an on-demand health check for a channel: validate the stored Meta token via debug_token and
 * flip the channel healthy / needs_reauth on a CONFIRMED bad token. A transient/inconclusive result
 * (network hiccup, no app creds) leaves the channel as-is — never flips a healthy channel down.
 * Non-Meta channels have no debug_token check → treated as healthy. Returns the resulting status.
 * Mirrors `sweepChannelHealth`, scoped to one workspace-owned channel.
 */
export async function runHealthCheck(workspaceId: string, id: string): Promise<ChannelStatus> {
  const ch = await ownChannelOr404(workspaceId, id);
  if (!META_HEALTH_PLATFORMS.has(ch.platform)) {
    await markChannelHealthy(id);
    return "active";
  }
  try {
    const blob = decryptTokens(ch.token_encrypted);
    const token = blob.access_token;
    // A10: an IG-Login-only channel (no FB access_token, but a messaging_token) has NO FB token to
    // validate — its access_token is "" and inspectMetaToken("") only returns null by luck. Its
    // inbound health is owned by the messaging-token refresh worker (which flips needs_reauth on a
    // refresh failure). Skip the FB-token inspection entirely; just keep the channel healthy and
    // re-apply the per-account IG-Login subscription (reconcile now handles IG-Login per-account).
    const isIgLoginOnly = !token && typeof blob.messaging_token === "string" && blob.messaging_token.length > 0;
    if (!isIgLoginOnly) {
      await inspectMetaToken(token ?? ""); // throws MetaTokenError on confirmed-bad; null = transient → leave alone
    }
    await markChannelHealthy(id);
    // WEBHOOKSUB1: keep the inbound subscription auto-configured to the complete field set on every
    // healthy check, so a self-hosted instance never silently drifts to a partial subscription.
    if (isSubscribablePlatform(ch.platform)) {
      await reconcileChannelSubscription(workspaceId, id).catch(() => {});
    }
    return "active";
  } catch (err) {
    if (err instanceof MetaTokenError) {
      await markChannelNeedsReauth(id, err.message);
      return "needs_reauth";
    }
    // Transient / decrypt error → don't flip; report the current status.
    return ch.status as ChannelStatus;
  }
}

export { CHANNEL_STATUSES, CHANNEL_SORTS };
