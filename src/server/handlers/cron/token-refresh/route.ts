import { createHash, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";
import { scanExpiringTokens } from "@/lib/workers/token-refresh-scan";

export const runtime = "nodejs";

/**
 * Cron job: scan for channels with expiring tokens and enqueue refresh jobs.
 * Protected by CRON_SECRET header (timing-safe comparison).
 *
 * Manual trigger for the same scan the worker now runs hourly in-process — kept so an
 * operator (or an external scheduler) can force a refresh sweep on demand.
 */
export async function GET(request: Request) {
  const secret = request.headers.get("x-cron-secret") ?? "";
  // Compare SHA-256 digests (always equal length) so the check is constant-time and does not
  // short-circuit on a length mismatch, which would leak CRON_SECRET's length.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  if (!env.CRON_SECRET || !timingSafeEqual(digest(secret), digest(env.CRON_SECRET))) {
    return new Response("Forbidden", { status: 403 });
  }

  const { enqueued } = await scanExpiringTokens();
  return Response.json({ enqueued });
}
