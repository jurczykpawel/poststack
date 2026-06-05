import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { runMigrations, runOnce } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;

let pool: Pool;
let addJob: typeof import("./client").addJob;
let closeQueue: typeof import("./client").closeQueue;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });
  // Start from a clean slate so re-runs are deterministic. `jobs` is a view;
  // the rows live in the internal _private_jobs table.
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  ({ addJob, closeQueue } = await import("./client"));
});

afterAll(async () => {
  if (closeQueue) await closeQueue();
  if (pool) await pool.end();
});

describe("queue integration (real Postgres) — graphile-worker swap", () => {
  it("addJob persists a job carrying the BullMQ-parity spec (task, maxAttempts, jobKey, runAt)", async () => {
    if (!TEST_DB) return;
    const before = Date.now();

    await addJob("sequence-step", { enrollmentId: "e-1" }, { jobKey: "seq-1", delayMs: 60_000 });

    const { rows } = await pool.query(
      "select task_identifier, max_attempts, key, run_at from graphile_worker.jobs where key = $1",
      ["seq-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].task_identifier).toBe("sequence-step");
    expect(rows[0].max_attempts).toBe(3); // sequence-step parity (was attempts:3)
    // delayMs:60s → run_at scheduled ~60s into the future
    expect(new Date(rows[0].run_at).getTime()).toBeGreaterThan(before + 50_000);
  });

  it("a runner consumes a due job from PG and the handler receives the exact payload", async () => {
    if (!TEST_DB) return;
    const captured: unknown[] = [];

    await addJob("token-refresh", { channelId: "ch-xyz" }, { jobKey: "tr-1" });

    await runOnce({
      connectionString: TEST_DB,
      taskList: {
        "token-refresh": (payload) => {
          captured.push(payload);
        },
      },
    });

    expect(captured).toEqual([{ channelId: "ch-xyz" }]);

    // Succeeded job is removed from the queue (graphile retention).
    const { rows } = await pool.query(
      "select count(*)::int as n from graphile_worker.jobs where key = $1",
      ["tr-1"],
    );
    expect(rows[0].n).toBe(0);
  });
});
