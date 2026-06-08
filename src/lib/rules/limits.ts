import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/** A Drizzle db or an open transaction — anything that can run `.execute`. */
type Executor = Pick<typeof db, "execute">;

/**
 * Atomic rule rate limits, Postgres-backed (replaces Redis SETNX / INCR).
 * The atomicity lives in `INSERT ... ON CONFLICT`, which serialises on the
 * composite PK — concurrent identical events cannot both win.
 *
 * Pass an open transaction as `executor` to make the limit mutation share the
 * caller's commit/rollback — so a cooldown/count is never spent on a reply that
 * then fails to enqueue (the whole unit rolls back and the event can retry).
 */

/**
 * Acquire the per-rule, per-contact cooldown. Returns true if the rule may
 * fire (lock acquired or previous cooldown expired), false while cooling down.
 */
export async function acquireCooldown(
  ruleId: string,
  contactId: string,
  cooldownSeconds: number,
  executor: Executor = db,
): Promise<boolean> {
  if (cooldownSeconds <= 0) return true; // no cooldown configured
  const result = await executor.execute(sql`
    INSERT INTO rule_cooldowns (rule_id, contact_id, expires_at)
    VALUES (${ruleId}::uuid, ${contactId}::uuid, now() + (${cooldownSeconds} * interval '1 second'))
    ON CONFLICT (rule_id, contact_id) DO UPDATE
      SET expires_at = now() + (${cooldownSeconds} * interval '1 second')
      WHERE rule_cooldowns.expires_at < now()
    RETURNING rule_id`);
  return result.rows.length > 0;
}

/**
 * Increment the lifetime send counter if it is still under `maxSends`.
 * Returns true if the rule may fire (counter incremented), false if at the cap.
 */
export async function incrementSendCount(
  ruleId: string,
  contactId: string,
  maxSends: number,
  executor: Executor = db,
): Promise<boolean> {
  if (maxSends <= 0) return false; // never send
  const result = await executor.execute(sql`
    INSERT INTO rule_send_counts (rule_id, contact_id, count)
    VALUES (${ruleId}::uuid, ${contactId}::uuid, 1)
    ON CONFLICT (rule_id, contact_id) DO UPDATE
      SET count = rule_send_counts.count + 1
      WHERE rule_send_counts.count < ${maxSends}
    RETURNING count`);
  return result.rows.length > 0;
}

/**
 * Non-mutating eligibility prechecks. These are an optimisation/guard so that an
 * ineligible rule does not run the expensive, fallible response planning (LLM
 * rephrase) before the authoritative transactional acquire. They are advisory only —
 * the in-transaction `acquireCooldown` / `incrementSendCount` remain the concurrency
 * authority, since a peek can race with a concurrent fire.
 */

/** True if the rule is currently cooling down for this contact (would not acquire). */
export async function isOnCooldown(
  ruleId: string,
  contactId: string,
  cooldownSeconds: number,
): Promise<boolean> {
  if (cooldownSeconds <= 0) return false; // no cooldown configured
  const result = await db.execute(sql`
    SELECT 1 FROM rule_cooldowns
    WHERE rule_id = ${ruleId}::uuid AND contact_id = ${contactId}::uuid AND expires_at > now()`);
  return result.rows.length > 0;
}

/** True if the rule has already reached its lifetime send cap for this contact. */
export async function isAtCap(
  ruleId: string,
  contactId: string,
  maxSends: number,
): Promise<boolean> {
  if (maxSends <= 0) return true; // never send
  const result = await db.execute(sql`
    SELECT 1 FROM rule_send_counts
    WHERE rule_id = ${ruleId}::uuid AND contact_id = ${contactId}::uuid AND count >= ${maxSends}`);
  return result.rows.length > 0;
}
