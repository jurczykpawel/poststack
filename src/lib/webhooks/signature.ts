import { createHmac, timingSafeEqual } from "node:crypto";

function hmac(secret: string, signed: string): string {
  return createHmac("sha256", secret).update(signed).digest("hex");
}

/** Build "t=<unix>,v1=<sig>[,v1=<sig2>]" over `${timestamp}.${rawBody}` (Stripe/Svix style). The
 *  second signature is emitted during a secret rotation so a receiver can verify with either secret. */
export function signWebhook(secrets: string[], timestamp: number, rawBody: string): string {
  const signed = `${timestamp}.${rawBody}`;
  const sigs = secrets.filter(Boolean).map((s) => `v1=${hmac(s, signed)}`);
  return `t=${timestamp},${sigs.join(",")}`;
}

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify a signature header against one secret. Replay-resistant via the signed timestamp (a stale
 *  `t` outside the tolerance window is rejected even with a valid signature). */
export function verifyWebhook(
  secret: string,
  header: string,
  rawBody: string,
  opts: { now?: number; toleranceSec?: number } = {},
): boolean {
  const tPart = header.split(",").find((kv) => kv.startsWith("t="));
  const t = Number(tPart?.slice(2));
  if (!Number.isFinite(t)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;
  const expected = hmac(secret, `${t}.${rawBody}`);
  return header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .some((kv) => eq(kv.slice(3), expected));
}
