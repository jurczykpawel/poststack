// TELEMETRY4: sender. Builds the anonymous envelope (see ./collect) and POSTs it to the configured
// telemetry endpoint. Strictly best-effort and self-contained: it never throws out of sendTelemetry,
// retries once on a failed attempt, then gives up with a single short warn (no payload, no secret in
// the log). A successful 2xx records the send time in the telemetry_state singleton so the
// send-on-boot debounce and the daily cron don't double-fire.

import { eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { telemetryState } from "@/db/schema";
import { env } from "@/lib/env";
import { hostFromUrl } from "@/lib/license/format";
import { buildEnvelope } from "./collect";

const SINGLETON = "singleton";
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
// Send-on-boot debounce: skip the boot send if a report already landed within this window, so a
// frequently-restarting worker doesn't spam the endpoint. The daily cron covers steady-state.
const BOOT_DEBOUNCE_MS = 20 * 60 * 60 * 1000; // ~20h

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * True when APP_URL points at a non-deployment host — localhost, a loopback ip, 0.0.0.0, an empty
 * host, or a *.local / *.localhost mDNS name. Telemetry is suppressed for these so local dev, CI and
 * test runs never phone home: each such run mints a fresh instance id and would otherwise inflate the
 * public fleet's "active instances" with throwaway entries (all hashing to the `localhost` domain).
 * A genuine self-host on a real domain still reports normally.
 */
export function isNonDeploymentHost(appUrl: string | undefined): boolean {
  const host = (hostFromUrl(appUrl ?? "") ?? "").toLowerCase();
  return (
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  );
}

/** One POST attempt. Resolves true on a 2xx response, false otherwise (non-2xx or thrown). */
async function postOnce(body: string): Promise<boolean> {
  try {
    const res = await fetch(env.TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send one anonymous usage report. No-op when telemetry is disabled (no fetch, no envelope build).
 * Best-effort: one retry, then give up — never throws, so a cron tick or worker boot is never broken
 * by a telemetry outage.
 */
export async function sendTelemetry(db: typeof Db): Promise<void> {
  if (!env.TELEMETRY_ENABLED || isNonDeploymentHost(env.APP_URL)) return;

  try {
    const envelope = await buildEnvelope(db);
    const body = JSON.stringify(envelope);

    let ok = await postOnce(body);
    if (!ok) {
      await delay(RETRY_DELAY_MS);
      ok = await postOnce(body);
    }

    if (!ok) {
      // No payload, no secret — just the fact that the send did not land.
      console.warn("[telemetry] send failed (will retry on the next schedule)");
      return;
    }

    await db
      .update(telemetryState)
      .set({ last_sent_at: new Date() })
      .where(eq(telemetryState.id, SINGLETON));
  } catch {
    // Building the envelope or writing the timestamp failed — stay silent-but-safe; a failed
    // telemetry send must never surface as an error to the caller.
    console.warn("[telemetry] send failed (will retry on the next schedule)");
  }
}

/**
 * Worker-startup hook. When telemetry is enabled, log the one-time enabled notice and — if no report
 * has landed within the debounce window — fire a send fire-and-forget so worker boot is never delayed
 * or broken by it. No-op (and no log) when telemetry is disabled.
 */
export async function sendTelemetryOnBoot(db: typeof Db): Promise<void> {
  if (!env.TELEMETRY_ENABLED || isNonDeploymentHost(env.APP_URL)) return;

  console.log(
    "[telemetry] Telemetry enabled (anonymous usage stats). Disable with POSTSTACK_TELEMETRY_DISABLED=true",
  );

  try {
    const row = await db.query.telemetryState.findFirst({ where: eq(telemetryState.id, SINGLETON) });
    const lastSentAt = row?.last_sent_at ?? null;
    const due = !lastSentAt || Date.now() - lastSentAt.getTime() >= BOOT_DEBOUNCE_MS;
    if (due) void sendTelemetry(db);
  } catch {
    // A failed state read must not break worker boot — skip the boot send; the cron still covers it.
  }
}
