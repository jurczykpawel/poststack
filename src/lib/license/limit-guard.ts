import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentTier, assertWithinLimit } from "./gate";
import type { LimitKind } from "./features";

/** A transaction-scoped DB executor (the value drizzle passes to the transaction callback). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// A transaction-scoped advisory lock per limit kind serialises concurrent creates so two requests
// can't both read "0 of 1" and both insert (the count-limit TOCTOU). Keys are arbitrary constants,
// distinct from the migrate lock and graphile-worker's own locks.
const LOCK_KEY: Record<LimitKind, number> = { brands: 920_001, apiKeys: 920_002 };

/**
 * Atomically enforce a tier count-limit and run the create in ONE transaction. The advisory lock makes
 * the count→assert→insert sequence mutually exclusive across connections, so a free instance can never
 * end up over its limit by racing. `exempt` lets an idempotent re-create (e.g. an existing brand key)
 * skip the limit and fall through to the create's own conflict handling.
 */
export async function createWithinLimit<T>(
  kind: LimitKind,
  opts: {
    count: (tx: Tx) => Promise<number>;
    create: (tx: Tx) => Promise<T>;
    exempt?: (tx: Tx) => Promise<boolean>;
  },
): Promise<T> {
  const tier = await currentTier();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY[kind]})`);
    if (!(opts.exempt && (await opts.exempt(tx)))) {
      assertWithinLimit(tier, kind, await opts.count(tx));
    }
    return opts.create(tx);
  });
}
