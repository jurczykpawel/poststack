import { createHmac } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { channels, accountSources } from "@/db/schema";
import { db } from "@/lib/db";
import { decryptTokens, requireEncryptionKey } from "@/lib/crypto";
import type { ChannelRef, InsightCredential } from "./types";

/** Token-specific revision; changes to the other login's token do not inherit evidence. */
export function insightCredentialRevision(transport: string, token: string): string {
  return createHmac("sha256", requireEncryptionKey()).update(JSON.stringify(["insights-v1", transport, token])).digest("hex");
}

/** Pass the open transaction as `executor` when called inside one, so no second pooled connection is taken. */
export async function resolveInsightCredential(ref: ChannelRef, transport: string | null, executor: Pick<typeof db, "query"> = db): Promise<InsightCredential | null> {
  if (transport !== null && transport !== "facebook" && transport !== "instagram_business") return null;
  const ch = await executor.query.channels.findFirst({ where: and(eq(channels.workspace_id, ref.workspaceId), eq(channels.id, ref.channelId), eq(channels.platform, "instagram"), isNull(channels.deleted_at)) });
  if (!ch || ch.workspace_id !== ref.workspaceId || ch.platform !== "instagram") return null;
  try {
    const blob = decryptTokens(ch.token_encrypted, [`ws:${ref.workspaceId}`, "channels.token_encrypted", ch.platform, ch.platform_id]);
    const candidates: InsightCredential[] = [];
    const add = (login: string, token: unknown) => {
      if (typeof token !== "string" || !token || /[\r\n]/.test(token)) return;
      const revision = insightCredentialRevision(login, token);
      candidates.push({ transport: login, token, accountKey: ch.platform_id, revision, budgetKey: `meta-user:${revision}` });
    };
    add("instagram_business", blob.messaging_token);
    if (ch.source_id) {
      const source = await executor.query.accountSources.findFirst({ where: and(
        eq(accountSources.workspace_id, ref.workspaceId), eq(accountSources.id, ch.source_id),
        eq(accountSources.provider, "meta"), eq(accountSources.kind, "user"), eq(accountSources.status, "active"),
      ) });
      if (source && source.workspace_id === ref.workspaceId && source.provider === "meta" && source.kind === "user" && source.status === "active") {
        try {
          const tokens = decryptTokens(source.token_encrypted, [`ws:${ref.workspaceId}`, "account_sources.token_encrypted", source.provider, source.provider_account_id]);
          add("facebook", tokens.access_token);
          const candidate = candidates.find((entry) => entry.transport === "facebook");
          if (candidate) candidate.budgetKey = `meta-source:${source.id}`;
        } catch { /* The other login can still have a usable credential. */ }
      }
    } else add("facebook", blob.user_access_token);
    if (transport) return candidates.find((candidate) => candidate.transport === transport) ?? null;
    const metadata = ch.metadata as { insights_credentials?: Record<string, { revision?: string; state?: string }> };
    const evidence = (candidate: InsightCredential) => {
      const entry = metadata?.insights_credentials?.[candidate.transport];
      return entry?.revision === candidate.revision ? entry.state : undefined;
    };
    const ready = candidates.find((candidate) => evidence(candidate) === "ready");
    if (ready) return ready;
    const eligible = candidates.filter((candidate) => !["needs_reauth", "missing_permission", "unsupported"].includes(evidence(candidate) ?? ""));
    return eligible.find((candidate) => candidate.transport === "facebook") ?? eligible[0] ?? null;
  } catch {
    return null;
  }
}
