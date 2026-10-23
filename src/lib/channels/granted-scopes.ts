import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { inspectMetaToken } from "@/lib/platforms/meta-token";

export async function recordGrantedScopes(channelId: string, scopes: string[] | null | undefined, workspaceId: string, tokenEncrypted?: string): Promise<void> {
  if (!scopes?.length) return;
  const stamp = { granted_scopes: scopes, granted_scopes_checked_at: new Date().toISOString() };
  await db.update(channels).set({ metadata: sql`coalesce(${channels.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb` })
    .where(and(eq(channels.id, channelId), eq(channels.workspace_id, workspaceId), tokenEncrypted ? eq(channels.token_encrypted, tokenEncrypted) : undefined));
}

export async function checkGrantedScopes(workspaceId: string, channelIds: string[]): Promise<void> {
  if (!channelIds.length) return;
  const rows = await db.query.channels.findMany({
    where: and(eq(channels.workspace_id, workspaceId), inArray(channels.id, channelIds)),
    columns: { id: true, token_encrypted: true },
  });
  for (const ch of rows) {
    try {
      const token = decryptTokens(ch.token_encrypted).access_token;
      if (!token) continue;
      const info = await inspectMetaToken(token);
      await recordGrantedScopes(ch.id, info?.scopes, workspaceId, ch.token_encrypted);
    } catch { /* Scope inspection is best-effort; connecting remains available. */ }
  }
}
