import { verifySolution, type Payload } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { rateLimit } from "@/lib/api/rate-limit";
import { getConfig } from "@/lib/settings/config";

interface VerifyResult {
  success: boolean;
  error?: string;
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
  const hmacKey = await getConfig("ALTCHA_HMAC_KEY");

  // Dev mode: skip verification when not configured
  if (!hmacKey) return { success: true };

  if (!payload) {
    return { success: false, error: "Security verification required" };
  }

  try {
    if (payload.length > 8192) return { success: false, error: "Security verification failed" };
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Payload;
    const id = decoded?.challenge?.signature;
    const expiresAt = decoded?.challenge?.parameters?.expiresAt;
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || !Number.isFinite(expiresAt)) {
      return { success: false, error: "Security verification failed" };
    }
    const result = await verifySolution({
      challenge: decoded.challenge, solution: decoded.solution,
      deriveKey, hmacSignatureSecret: hmacKey,
    });
    if (!result.verified) {
      return { success: false, error: "Security verification failed" };
    }

    // Single-use: reject a second redemption of the same solved challenge.
    const consumed = await rateLimit(`altcha:${id}`, 1, 3600);
    if (!consumed.allowed) {
      return { success: false, error: "Security verification failed" };
    }

    return { success: true };
  } catch (err) {
    console.error("[captcha] Verification error:", err);
    return { success: false, error: "Security verification failed" };
  }
}
