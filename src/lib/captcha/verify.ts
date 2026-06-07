import { verifySolution } from "altcha-lib";
import { rateLimit } from "@/lib/api/rate-limit";

interface VerifyResult {
  success: boolean;
  error?: string;
}

/** Pull a stable per-challenge id (its signature) out of the base64 payload. */
function challengeId(payload: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      signature?: string;
      challenge?: string;
    };
    return decoded.signature ?? decoded.challenge ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify an Altcha proof-of-work payload server-side.
 * Returns { success: true } if valid, { success: false, error } otherwise.
 * If ALTCHA_HMAC_KEY is not set, verification is skipped (dev mode).
 *
 * A solved challenge may only be redeemed once: after a valid signature we
 * consume its id through the shared counter store, so the same payload cannot
 * be replayed within its validity window.
 */
export async function verifyCaptcha(
  payload: string | null | undefined
): Promise<VerifyResult> {
  const hmacKey = process.env.ALTCHA_HMAC_KEY;

  // Dev mode: skip verification when not configured
  if (!hmacKey) return { success: true };

  if (!payload) {
    return { success: false, error: "Security verification required" };
  }

  try {
    const ok = await verifySolution(payload, hmacKey);
    if (!ok) {
      return { success: false, error: "Security verification failed" };
    }

    // Single-use: reject a second redemption of the same solved challenge.
    const id = challengeId(payload);
    if (id) {
      const consumed = await rateLimit(`altcha:${id}`, 1, 3600);
      if (!consumed.allowed) {
        return { success: false, error: "Security verification failed" };
      }
    }

    return { success: true };
  } catch (err) {
    console.error("[captcha] Verification error:", err);
    return { success: false, error: "Security verification failed" };
  }
}
