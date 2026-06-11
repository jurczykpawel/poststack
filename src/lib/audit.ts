import { db } from "@/lib/db";
import { auditLogs } from "@/db/schema";
import type { AuthContext } from "@/lib/auth";

export type AuditActorType = "user" | "api_key" | "system";

export interface AuditActor {
  type: AuditActorType;
  id?: string;
}

/** Known audit actions. Kept as a catalog (enum-first) so action strings don't
 * drift over time. Add entries as new write points are wired. */
export const AuditAction = {
  ChannelConnected: "channel.connected",
  ChannelDisconnected: "channel.disconnected",
  ChannelDrained: "channel.drained",
  ContactErased: "contact.erased",
  MessagesPruned: "messages.pruned",
  WebhookEventsPruned: "webhook_events.pruned",
} as const;

/** Derive the audit actor from a request's auth context (never the raw key). */
export function actorFromAuth(auth: AuthContext): AuditActor {
  return { type: auth.authMethod === "api_key" ? "api_key" : "user", id: auth.userId };
}

export interface RecordAuditInput {
  workspaceId: string;
  actor: AuditActor;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Identifiers and counts only — never tokens or message payloads. */
  metadata?: Record<string, unknown>;
}

/**
 * Append a row to the audit log. Best-effort: a failure here must never block
 * the action being audited, so errors are swallowed (logged, not thrown).
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      workspace_id: input.workspaceId,
      actor_type: input.actor.type,
      actor_id: input.actor.id ?? null,
      action: input.action,
      target_type: input.targetType ?? null,
      target_id: input.targetId ?? null,
      metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : null,
    });
  } catch (err) {
    console.error("[audit] failed to record:", err instanceof Error ? err.message : String(err));
  }
}
