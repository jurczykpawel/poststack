// REALTIME1 · R2 — the realtime hub. One dedicated Postgres LISTEN connection per web process; a
// workspace-keyed in-process fan-out. The worker process emits `pg_notify('realtime', {ws,kind,id})`
// (see notifyRealtime); this hub LISTENs, parses, and delivers ONLY to that workspace's subscribers.
//
// SECURITY INVARIANT (the reason this file exists): a subscriber for workspace A must NEVER receive a
// notification for workspace B. The fan-out is keyed strictly by `ws`; `dispatch` is pure + exported
// so the isolation invariant is unit-testable without a live database.
import { Client } from "pg";

/** A coarse realtime signal delivered to a subscriber: which kind of thing changed, + its id. */
export interface RealtimeSignal {
  kind: string;
  id: string;
}

export type Subscriber = (signal: RealtimeSignal) => void;

// workspaceId → set of live subscribers (SSE streams). A Set so the same callback can't double-register
// and removal on disconnect is O(1).
const byWorkspace = new Map<string, Set<Subscriber>>();

/** Register an SSE subscriber for a workspace. Returns an unsubscribe fn (call on disconnect). */
export function subscribe(workspaceId: string, fn: Subscriber): () => void {
  let set = byWorkspace.get(workspaceId);
  if (!set) {
    set = new Set();
    byWorkspace.set(workspaceId, set);
  }
  set.add(fn);
  return () => {
    const s = byWorkspace.get(workspaceId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) byWorkspace.delete(workspaceId); // no leaked empty buckets
  };
}

/** Current subscriber count for a workspace (0 if none) — for tests / introspection. */
export function subscriberCount(workspaceId: string): number {
  return byWorkspace.get(workspaceId)?.size ?? 0;
}

/**
 * Parse a raw `realtime` NOTIFY payload and fan it out to ONLY that workspace's subscribers. Pure
 * (no DB) + exported so the workspace-isolation invariant is directly testable. A malformed payload
 * or a delivery throwing in one subscriber never affects the others.
 */
export function dispatch(rawPayload: string): void {
  let parsed: { ws?: unknown; kind?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return;
  }
  const ws = typeof parsed.ws === "string" ? parsed.ws : null;
  const kind = typeof parsed.kind === "string" ? parsed.kind : null;
  const id = typeof parsed.id === "string" ? parsed.id : "";
  if (!ws || !kind) return;
  const set = byWorkspace.get(ws);
  if (!set || set.size === 0) return;
  // Snapshot so a subscriber that unsubscribes during delivery (e.g. its stream closed) is safe.
  for (const fn of [...set]) {
    try {
      fn({ kind, id });
    } catch {
      /* one bad subscriber must not break fan-out */
    }
  }
}

// ── the dedicated LISTEN connection (one per web process) ────────────────────────────────────────
let client: Client | null = null;
let starting: Promise<void> | null = null;

/**
 * Open the single long-lived LISTEN connection for this process and route every `realtime`
 * notification into `dispatch`. Idempotent: repeated calls return the same in-flight/established
 * connection. On connection error it resets so a later call can reconnect (best-effort; a missed
 * NOTIFY just means the client re-fetches on its next interaction).
 */
export async function startRealtimeListener(connectionString = process.env.DATABASE_URL): Promise<void> {
  if (client) return;
  if (starting) return starting;
  starting = (async () => {
    const c = new Client({ connectionString });
    c.on("notification", (msg) => {
      if (msg.channel === "realtime" && msg.payload) dispatch(msg.payload);
    });
    c.on("error", () => {
      // Drop the broken connection; the next startRealtimeListener() reconnects.
      client = null;
      starting = null;
      c.end().catch(() => {});
    });
    await c.connect();
    await c.query("LISTEN realtime");
    client = c;
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

/** Stop the LISTEN connection (graceful shutdown / tests). */
export async function stopRealtimeListener(): Promise<void> {
  const c = client;
  client = null;
  starting = null;
  if (c) await c.end().catch(() => {});
}

/** Test seam: clear all subscribers (so suites don't leak fan-out state between tests). */
export function __resetHub(): void {
  byWorkspace.clear();
}
