import { and, eq, isNull } from "drizzle-orm";
import { accountSources, channels, insightConnections } from "@/db/schema";
import { db } from "@/lib/db";
import { decryptTokens } from "@/lib/crypto";
import { resolveInsightCredential, insightCredentialRevision } from "./credentials";
import type { ChannelRef } from "./types";

/** Reconcile stored evidence against the current credentials without contacting the provider. */
export async function reconcileInsightCredentials(ref: ChannelRef): Promise<boolean> {
  return db.transaction(async tx=>{
    const initial=await tx.query.channels.findFirst({where:and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId),eq(channels.platform,"instagram"))});
    if (!initial) return false;
    const [source] = initial.source_id ? await tx.select().from(accountSources).where(and(eq(accountSources.workspace_id,ref.workspaceId),eq(accountSources.id,initial.source_id))).for("update") : [];
    const [channel]=await tx.select().from(channels).where(and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId),isNull(channels.deleted_at))).for("update");
    if (!channel || channel.source_id !== initial.source_id) return false;
    const [connection]=await tx.select().from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId))).for("update");
    if (!connection) return false;
    const [fb,ig]=await Promise.all([resolveInsightCredential(ref,"facebook"),resolveInsightCredential(ref,"instagram_business")]);
    let fbRevision=fb?.revision ?? null;
    // Source availability does not change the version of its stored credential.
    if (!fbRevision && source?.provider === "meta" && source.kind === "user") {
      try {
        const blob=decryptTokens(source.token_encrypted,[`ws:${ref.workspaceId}`,"account_sources.token_encrypted",source.provider,source.provider_account_id]);
        if (typeof blob.access_token === "string" && blob.access_token && !/[\r\n]/.test(blob.access_token)) fbRevision=insightCredentialRevision("facebook",blob.access_token);
      } catch { /* An unreadable credential cannot retain access evidence. */ }
    }
    const fbChanged=!!connection.fb_grants.revision && connection.fb_grants.revision !== fbRevision;
    const igChanged=!!connection.ig_grants.revision && connection.ig_grants.revision !== ig?.revision;
    const selectedRevision=connection.transport === "facebook" ? fbRevision : connection.transport === "instagram_business" ? ig?.revision ?? null : null;
    const selected=connection.transport === "facebook" ? fb : connection.transport === "instagram_business" ? ig : null;
    const selectedChanged=!!connection.transport && (connection.credential_revision ? connection.credential_revision !== selectedRevision : connection.access_state !== "unknown" && !!selected);
    const unavailable=connection.collection_mode === "on" && !fb && !ig;
    const availabilityChanged=unavailable && connection.access_state !== "needs_reauth";
    const recovered=connection.collection_mode === "on" && connection.transport === null && connection.access_state === "needs_reauth" && !!(fb || ig);
    const refresh=selectedChanged || availabilityChanged || recovered;
    if (!fbChanged && !igChanged && !refresh) return false;
    const empty={version:1 as const,names:[],checkedAt:null,revision:null};
    await tx.update(insightConnections).set({
      ...(fbChanged?{fb_grants:empty}:{}),...(igChanged?{ig_grants:empty}:{}),
      ...(refresh?{credential_revision:null,access_state:unavailable || (selectedChanged && !selectedRevision) ? "needs_reauth" as const : "unknown" as const,access_checked_at:null,reason:connection.collection_mode === "off" ? "collection_off" as const : unavailable || (selectedChanged && !selectedRevision) ? "token_required" as const : "first_sync" as const,claim_token:null,claim_until:null,checkpoint:{version:1 as const},next_due_at:new Date()}:{}),
    }).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId)));
    return connection.collection_mode === "on" && refresh;
  });
}

/** A refreshed credential schedules an access check while retaining the provider budget/backoff. */
export async function scheduleInsightCredentialCheck(ref: ChannelRef): Promise<void> {
  if (await reconcileInsightCredentials(ref)) {
    const {hasFeature}=await import("@/lib/license/gate");
    if (await hasFeature("insights")) {
      const {enqueueInsights}=await import("./schedule");
      await enqueueInsights(ref,"scheduled");
    }
  }
}
