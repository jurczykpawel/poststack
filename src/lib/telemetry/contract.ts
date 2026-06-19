// The canonical SENDER-side contract for the telemetry envelope `buildEnvelope` produces. This zod
// schema mirrors the wire format EXACTLY: the top level, `identity` and `deployment` are `.strict()`,
// so any added/renamed/dropped/retyped field on the sender breaks `npm test` (the receiver pins the
// same shape on its end). `metrics` is intentionally open — it models its KNOWN counters but allows
// passthrough, so new counters can ship without a wire-format break.

import { z } from "zod";

const integrations = z
  .object({
    google: z.boolean(),
    ai: z.boolean(),
    storage: z.string().nullable(),
  })
  .strict();

const deployment = z
  .object({
    app_version: z.string(),
    runtime: z.literal("bun"),
    runtime_version: z.string(),
    os: z.string(),
    arch: z.string(),
    cpu_count: z.number(),
    mem_total_mb: z.number(),
    node_env: z.string(),
    registration_enabled: z.boolean(),
    history_retention_days: z.number(),
    platforms_enabled: z.array(z.string()),
    integrations,
  })
  .strict();

const identity = z
  .object({
    domain_hash: z.string(),
    license_hash: z.string().nullable(),
    license_tier: z.string().nullable(),
  })
  .strict();

const byThreadType = z.record(
  z.string(),
  z.object({
    answer_rate_pct: z.number(),
    avg_first_response_ms: z.number().nullable(),
  }),
);

// `metrics` is the open/extensible part of the envelope: its KNOWN counters are typed, but
// `.passthrough()` lets future counters ride along without breaking the contract.
const metrics = z
  .object({
    workspaces: z.number(),
    channels: z.object({
      total: z.number(),
      by_platform: z.record(z.string(), z.number()),
      needs_reauth: z.number(),
    }),
    contacts: z.number(),
    conversations: z.number(),
    rules: z.number(),
    sequences: z.number(),
    webhooks_processed: z.object({
      total: z.number(),
      last_24h: z.number(),
      by_status: z.record(z.string(), z.number()),
    }),
    messages_sent: z.object({ total: z.number(), last_24h: z.number() }),
    comments_replied: z.object({ total: z.number() }),
    response_times: z.object({
      window_days: z.number(),
      answer_rate_pct: z.number(),
      avg_first_response_ms: z.number().nullable(),
      p50_bucket: z.string().nullable(),
      p90_bucket: z.string().nullable(),
      by_thread_type: byThreadType,
    }),
  })
  .passthrough();

/** The versioned telemetry envelope contract — the wire format both sender and receiver pin against. */
export const telemetryEnvelopeV1 = z
  .object({
    schema_version: z.literal(1),
    project: z.string(),
    instance_id: z.string().uuid(),
    sent_at: z.string().datetime(),
    identity,
    deployment,
    metrics,
  })
  .strict();

export type TelemetryEnvelopeV1 = z.infer<typeof telemetryEnvelopeV1>;
