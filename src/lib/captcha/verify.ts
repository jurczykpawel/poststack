import { verifySolution } from "altcha-lib";

interface VerifyResult {
  success: boolean;
  error?: string;
}

/**
 * Verify an Altcha proof-of-work payload server-side.
 * Returns { success: true } if valid, { success: false, error } otherwise.
 * If ALTCHA_HMAC_KEY is not set, verification is skipped (dev mode).
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
    return { success: true };
  } catch (err) {
    console.error("[captcha] Verification error:", err);
    return { success: false, error: "Security verification failed" };
  }
}
