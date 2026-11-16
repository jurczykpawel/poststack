import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { auditLogs } from "@/db/schema";
import { AuditAction, type AuditActor } from "@/lib/audit";
import type { DbTx } from "@/lib/deliveries/service";

export async function recordTikTokConsent(workspaceId: string, actor: AuditActor, targetType: string, targetId: string, metadata: Record<string, unknown>, submission: unknown, tx?: DbTx) {
  await (tx ?? db).insert(auditLogs).values({
    workspace_id: workspaceId, actor_type: actor.type, actor_id: actor.id,
    action: AuditAction.TikTokSubmissionConfirmed, target_type: targetType, target_id: targetId,
    metadata: { ...metadata, submissionHash: createHash("sha256").update(JSON.stringify(submission)).digest("hex") },
  });
}
