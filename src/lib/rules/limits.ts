import { prisma } from "@/lib/prisma";

/**
 * Atomic rule rate limits, Postgres-backed (replaces Redis SETNX / INCR).
 * The atomicity lives in `INSERT ... ON CONFLICT`, which serialises on the
 * composite PK — concurrent identical events cannot both win.
 */

/**
 * Acquire the per-rule, per-contact cooldown. Returns true if the rule may
 * fire (lock acquired or previous cooldown expired), false while cooling down.
 */
export async function acquireCooldown(
  ruleId: string,
  contactId: string,
  cooldownSeconds: number,
): Promise<boolean> {
  if (cooldownSeconds <= 0) return true; // no cooldown configured
  const rows = await prisma.$queryRaw<Array<{ rule_id: string }>>`
    INSERT INTO rule_cooldowns (rule_id, contact_id, expires_at)
    VALUES (${ruleId}::uuid, ${contactId}::uuid, now() + (${cooldownSeconds} * interval '1 second'))
    ON CONFLICT (rule_id, contact_id) DO UPDATE
      SET expires_at = now() + (${cooldownSeconds} * interval '1 second')
      WHERE rule_cooldowns.expires_at < now()
    RETURNING rule_id`;
  return rows.length > 0;
}

/**
 * Increment the lifetime send counter if it is still under `maxSends`.
 * Returns true if the rule may fire (counter incremented), false if at the cap.
 */
export async function incrementSendCount(
  ruleId: string,
  contactId: string,
  maxSends: number,
): Promise<boolean> {
  if (maxSends <= 0) return false; // never send
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO rule_send_counts (rule_id, contact_id, count)
    VALUES (${ruleId}::uuid, ${contactId}::uuid, 1)
    ON CONFLICT (rule_id, contact_id) DO UPDATE
      SET count = rule_send_counts.count + 1
      WHERE rule_send_counts.count < ${maxSends}
    RETURNING count`;
  return rows.length > 0;
}
