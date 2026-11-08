import { createHmac } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { accountSources, channels, insightConnections } from "@/db/schema";
import { db } from "@/lib/db";
import type { SessionAuthContext } from "@/lib/auth";
import { decryptTokens, encryptTokens, requireEncryptionKey } from "@/lib/crypto";
import { ApiError, err } from "@/lib/api/response";
import { requireFeature } from "@/lib/license/gate";
import { generateOAuthState, safeEqual, type OAuthPurpose } from "@/lib/oauth/state";
import { getProvider } from "@/lib/platforms/registry";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { buildInstagramLoginAuthUrl } from "@/lib/platforms/instagram-login";
import { getConfig } from "@/lib/settings/config";
import { addJobTx } from "@/lib/queue/client";
import { env } from "@/lib/env";
import { resolveInsightCredential } from "./credentials";
import { getInsightStatus, setCollectionMode } from "./service";
import { enqueueInsights } from "./schedule";
import type { ChannelRef } from "./types";

type ConsentContext = { state: string; transport: string; binding: string; fingerprint: string; expiresAt: number };
type ConsentMetadata = Record<string, unknown> & { insight_consent?: ConsentContext; insight_consent_completion?: ConsentContext };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
function assertSession(ref: ChannelRef, auth: SessionAuthContext) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.channelId)) throw new ApiError("not_found", "Channel not found", 404);
  if (auth.authMethod !== "session" || !auth.sessionId || auth.workspaceId !== ref.workspaceId) throw new ApiError("unauthorized", "Session required", 401);
}
function binding(auth: SessionAuthContext) {
  return createHmac("sha256", requireEncryptionKey()).update(JSON.stringify(["insights-consent",auth.workspaceId,auth.userId,auth.sessionId])).digest("hex");
}
function fingerprint(channel: typeof channels.$inferSelect, source?: typeof accountSources.$inferSelect) {
  return createHmac("sha256", requireEncryptionKey()).update(JSON.stringify([channel.token_encrypted,channel.source_id,source?.token_encrypted])).digest("hex");
}
async function lockedContext(tx: Tx, ref: ChannelRef) {
  const initial = await tx.query.channels.findFirst({where:and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId))});
  if (!initial) throw new ApiError("not_found","Channel not found",404);
  const [source] = initial.source_id ? await tx.select().from(accountSources).where(and(eq(accountSources.workspace_id,ref.workspaceId),eq(accountSources.id,initial.source_id))).for("update") : [];
  const [channel] = await tx.select().from(channels).where(and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId),isNull(channels.deleted_at))).for("update");
  if (!channel || channel.platform !== "instagram" || channel.status === "disabled" || channel.source_id !== initial.source_id) throw new ApiError("not_found","Channel not found",404);
  const [connection] = await tx.select().from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId))).for("update");
  if (connection?.collection_mode !== "on") throw new ApiError("invalid_request","Insights collection is off",409);
  return {channel,source,connection,metadata:{...(channel.metadata as ConsentMetadata)}};
}
function valid(context: ConsentContext | undefined, auth: SessionAuthContext, currentFingerprint: string) {
  if (!context || !safeEqual(context.binding,binding(auth)) || context.expiresAt <= Date.now() || !safeEqual(context.fingerprint,currentFingerprint)) throw new ApiError("invalid_request","Insights consent expired; try again",409);
  return context;
}
function channelWhere(ref: ChannelRef) { return and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId)); }
function connectionWhere(ref: ChannelRef) { return and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId),eq(insightConnections.collection_mode,"on")); }
export function insightConsentPath(channelId: string): string { return `/insights?channel=${encodeURIComponent(channelId)}`; }

export async function beginInsightConsent(ref: ChannelRef, auth: SessionAuthContext): Promise<Response> {
  assertSession(ref,auth);
  const status = await getInsightStatus(ref);
  if (status.platform !== "instagram") return err("unsupported","Insights consent is unavailable for this platform",422);
  // Explicit transport selection also permits renewing a credential with declined access.
  const credential = await resolveInsightCredential(ref,status.transport) ?? await resolveInsightCredential(ref,"facebook") ?? await resolveInsightCredential(ref,"instagram_business");
  let transport = credential?.transport;
  if (!transport) {
    const channel = await db.query.channels.findFirst({where:channelWhere(ref)});
    const source = channel?.source_id ? await db.query.accountSources.findFirst({where:and(eq(accountSources.workspace_id,ref.workspaceId),eq(accountSources.id,channel.source_id),eq(accountSources.provider,"meta"),eq(accountSources.kind,"user"))}) : null;
    if (source && source.status !== "disabled") transport="facebook";
  }
  if (!transport) return err("credential_required","Connect an Instagram Business Login or a Meta User managed connection to enable Insights. A Page token cannot provide account Insights.",422);
  const flow = transport === "facebook" ? "instagram" : "instagram-login";
  const appPrefix = transport === "facebook" ? "META" : "INSTAGRAM";
  const [appId,appSecret] = await Promise.all([getConfig(`${appPrefix}_APP_ID`),getConfig(`${appPrefix}_APP_SECRET`)]);
  if (!appId || !appSecret) return err("not_configured","Configure the selected Instagram login before enabling Insights",422);
  const purpose: OAuthPurpose = {kind:"insights",channelId:ref.channelId,transport};
  const {state,setCookie} = generateOAuthState(auth,flow,purpose);
  const redirectUri = `${env.APP_URL}/api/oauth/${flow}/callback`;
  const url = transport === "facebook" ? await getProvider("instagram").generateAuthUrl(state,redirectUri,purpose) : await buildInstagramLoginAuthUrl(state,redirectUri,purpose);
  await setCollectionMode(ref,"on");
  await db.transaction(async tx=>{
    const {channel,source,metadata}=await lockedContext(tx,ref);
    await requireFeature("insights");
    metadata.insight_consent={state,transport,binding:binding(auth),fingerprint:fingerprint(channel,source),expiresAt:Date.now()+600000};
    delete metadata.insight_consent_completion;
    await tx.update(channels).set({metadata}).where(channelWhere(ref));
  });
  return new Response(null,{status:302,headers:{Location:url,"Set-Cookie":setCookie}});
}

export async function consumeInsightConsent(ref: ChannelRef, auth: SessionAuthContext, state: string, transport: string): Promise<void> {
  assertSession(ref,auth);
  await db.transaction(async tx=>{
    const {channel,source,metadata}=await lockedContext(tx,ref);
    await requireFeature("insights");
    const context=valid(metadata.insight_consent,auth,fingerprint(channel,source));
    if (!safeEqual(context.state,state) || context.transport !== transport) throw new ApiError("invalid_request","Invalid Insights consent context",409);
    delete metadata.insight_consent;
    metadata.insight_consent_completion=context;
    await tx.update(channels).set({metadata}).where(channelWhere(ref));
  });
}

export async function declineInsightConsent(ref: ChannelRef, auth: SessionAuthContext, state?: string): Promise<void> {
  assertSession(ref,auth);
  await db.transaction(async tx=>{
    const {channel,source,metadata}=await lockedContext(tx,ref);
    const context=valid(metadata.insight_consent_completion,auth,fingerprint(channel,source));
    if (state !== undefined && !safeEqual(context.state,state)) throw new ApiError("invalid_request","Invalid Insights consent context",409);
    await requireFeature("insights");
    delete metadata.insight_consent_completion;
    await tx.update(channels).set({metadata}).where(channelWhere(ref));
    const credential=await resolveInsightCredential(ref,context.transport);
    await tx.update(insightConnections).set({transport:context.transport,access_state:"missing_permission",reason:"permission_required",credential_revision:credential?.revision ?? null,access_checked_at:null,claim_token:null,claim_until:null}).where(connectionWhere(ref));
  });
}

export async function finishInsightConsent(ref: ChannelRef, auth: SessionAuthContext, accounts: ConnectedAccount[], state?: string): Promise<void> {
  assertSession(ref,auth);
  await requireFeature("insights");
  const initial=await db.query.channels.findFirst({where:channelWhere(ref)});
  if (!initial) throw new ApiError("not_found","Channel not found",404);
  const account=accounts.find(a=>a.platformId===initial.platform_id);
  if (!account || accounts.filter(a=>a.platformId===initial.platform_id).length !== 1) throw new ApiError("invalid_request","Select the Instagram account linked to this channel",422);
  const completion=(initial.metadata as ConsentMetadata).insight_consent_completion;
  let sourceIdentity: string | undefined;
  if (initial.source_id && completion?.transport === "facebook") {
    const token=account.tokens.user_access_token;
    if (typeof token !== "string" || !token) throw new ApiError("invalid_request","A Meta User credential is required",422);
    const {fetchTokenIdentity}=await import("@/lib/channels/account-source");
    sourceIdentity=(await fetchTokenIdentity(token)).id;
  }
  await db.transaction(async tx=>{
    const {channel,source,metadata}=await lockedContext(tx,ref);
    const context=valid(metadata.insight_consent_completion,auth,fingerprint(channel,source));
    if (state !== undefined && !safeEqual(context.state,state)) throw new ApiError("invalid_request","Invalid Insights consent context",409);
    await requireFeature("insights");
    const blob=decryptTokens(channel.token_encrypted,[`ws:${ref.workspaceId}`,"channels.token_encrypted",channel.platform,channel.platform_id]);
    if (context.transport === "instagram_business") {
      if (typeof account.tokens.messaging_token !== "string" || !account.tokens.messaging_token) throw new ApiError("invalid_request","An Instagram Business Login credential is required",422);
      blob.messaging_token=account.tokens.messaging_token;
      blob.messaging_token_expires_at=account.tokens.messaging_token_expires_at;
    } else {
      if (typeof account.tokens.user_access_token !== "string" || !account.tokens.user_access_token) throw new ApiError("invalid_request","A Meta User credential is required",422);
      if (channel.source_id) {
        if (!source || source.kind !== "user" || source.provider !== "meta" || source.status === "disabled" || source.provider_account_id !== sourceIdentity) throw new ApiError("invalid_request","Use the Meta User who owns this managed connection",422);
        const sourceBlob=decryptTokens(source.token_encrypted,[`ws:${ref.workspaceId}`,"account_sources.token_encrypted",source.provider,source.provider_account_id]);
        await tx.update(accountSources).set({token_encrypted:encryptTokens({...sourceBlob,access_token:account.tokens.user_access_token}),status:"active",needs_reauth_reason:null,last_error:null}).where(and(eq(accountSources.workspace_id,ref.workspaceId),eq(accountSources.id,source.id)));
      }
      // Keep the independent Instagram Business Login fields.
      Object.assign(blob, Object.fromEntries(Object.entries(account.tokens).filter(([key])=>!key.startsWith("messaging_token"))));
    }
    delete metadata.insight_consent_completion;
    delete metadata.insight_consent;
    const recoverSourceChannel = context.transport === "facebook" && source?.status === "needs_reauth" && channel.status === "needs_reauth";
    const unix=Number(blob.messaging_token_expires_at);
    const expiresAt=Number(account.tokens.expires_at);
    await tx.update(channels).set({token_encrypted:encryptTokens(blob),metadata,
      ...(recoverSourceChannel ? {status:"active" as const,last_error:null,needs_reauth_reason:null} : {}),
      ...(context.transport === "instagram_business" ? {messaging_token_expires_at:Number.isFinite(unix)&&unix>0?new Date(unix*1000):null} : {token_expires_at:Number.isFinite(expiresAt)&&expiresAt>0?new Date(expiresAt*1000):null}),
    }).where(channelWhere(ref));
    if (recoverSourceChannel) await addJobTx(tx,"drain-channel",{channelId:ref.channelId},{jobKey:`drain-channel:${ref.channelId}`});
    await tx.update(insightConnections).set({transport:context.transport,access_state:"unknown",credential_revision:null,access_checked_at:null,reason:"first_sync",claim_token:null,claim_until:null,
      ...(context.transport === "facebook" ? {fb_grants:{version:1,names:[],checkedAt:null,revision:null}} : {ig_grants:{version:1,names:[],checkedAt:null,revision:null}}),
      checkpoint:{version:1},next_due_at:new Date(),
    }).where(connectionWhere(ref));
  });
  await enqueueInsights(ref,"consent");
}
