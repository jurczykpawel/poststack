import { createChallenge, solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";

export const CAPTCHA_HMAC = "test-altcha-hmac-key-0123456789";

export async function solvedCaptcha(expiresAt = new Date(Date.now() + 600_000)) {
  const challenge = await createChallenge({
    algorithm: "PBKDF2/SHA-256", cost: 10, counter: 2, deriveKey,
    hmacSignatureSecret: CAPTCHA_HMAC, expiresAt,
  });
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error("could not solve test challenge");
  return { challenge, solution };
}

export function encodeCaptcha(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
