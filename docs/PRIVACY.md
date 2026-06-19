# Telemetry & privacy

PostStack sends a small, **anonymous** usage report to the maintainer once per day.
It contains aggregate counts and deployment shape only — never your message content,
contact data, tokens, or domain. This document describes exactly what is sent, what is
not, why, and how to turn it off.

Telemetry is **on by default** (opt-out, the same model as many self-hosted tools).

## What is sent

The report is a single versioned JSON envelope, built once per send. Its fields:

### Identity (one-way hashes only)

- **`instance_id`** — a random anonymous UUID, generated once on first run and persisted.
  It is not derived from anything about you; it only lets repeated reports from the same
  instance be counted as one.
- **`domain_hash`** — a salted SHA-256 hash of your instance's hostname (from `APP_URL`).
  This is **not** your domain — it is a one-way hash, so the raw domain cannot be recovered
  from it. It only lets the maintainer count distinct instances.
- **`license_hash`** + **`license_tier`** — only present if the instance is licensed: a
  salted SHA-256 hash of the license order id (not the order id itself) and the tier name
  (e.g. `pro`). Absent (null) on the free tier.

### Deployment shape

A description of *how* the instance is deployed — never *who* runs it:

- App version, runtime (`bun`) and runtime version
- OS platform, CPU architecture, CPU count, total memory (MB)
- `node_env` (e.g. `production`)
- Whether registration is enabled (boolean)
- History retention window (days)
- Which platforms are connected (e.g. `facebook`, `instagram`) — labels only
- Integration on/off booleans: Google connected, AI rephrase configured, and a short
  object-storage **label** (`b2` / `r2` / `s3`, or none) — never the endpoint or credentials

### Aggregate usage metrics

Instance-wide counts, summed across all workspaces — never per-record data:

- Workspaces, channels (total + count per platform + how many need re-auth), contacts,
  conversations, auto-reply rules, sequences
- Webhooks processed (total, last 24h, counts grouped by handling status)
- Messages sent (total, last 24h)
- Comments replied (total)
- Response-time aggregates: the rolling window length, the answer rate (%), the average
  first-response time (ms), and percentile **buckets** (p50/p90 as coarse labels, not raw
  per-conversation timings) — overall and broken down by thread type

## What is NOT sent

- **No message content** — not a single inbox message, comment, or reply body
- **No contact PII** — no names, emails, phone numbers, profile ids, or any per-contact data
- **No OAuth tokens, secrets, API keys, or passwords**
- **No raw domain** — only the salted hash described above
- **No per-record data** — only aggregate counts and averages; nothing that identifies an
  individual workspace, channel, conversation, or person

## Why

The aggregate report gives the maintainer product and usage insight — how many instances
are running, which platforms and integrations are actually used, rough scale, and whether
auto-replies are landing fast — so development can be prioritized around real usage. None
of it can be tied back to a person or a domain.

## How to disable

Set this environment variable and restart:

```bash
POSTSTACK_TELEMETRY_DISABLED=true
```

With telemetry disabled, **no report is ever built and nothing is sent** (no network call
at all). The equivalent `POSTSTACK_TELEMETRY_ENABLED=false` also works.

If you would rather keep telemetry on but send it to your **own** receiver instead of the
maintainer's, repoint the endpoint:

```bash
TELEMETRY_URL=https://your-own-receiver.example/ingest
```

## Cadence

- **Roughly once per day** (a daily scheduled send).
- **Once on startup** — but only if a report has not already landed within the last ~20
  hours, so a frequently-restarting process never spams the endpoint.

Sending is strictly best-effort: a telemetry outage never delays startup, never fails a
scheduled job, and never surfaces an error to you.
