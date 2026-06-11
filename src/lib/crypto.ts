import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";
import type { TokenData } from "@/lib/platforms/base";

export type { TokenData };

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Encrypt an arbitrary string at rest (AES-256-GCM).
 * Returns hex string: iv:authTag:ciphertext
 */
export function encryptString(plaintext: string): string {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

/**
 * Decrypt a string produced by encryptString.
 * Throws if decryption fails (tampered data or wrong key).
 */
export function decryptString(encrypted: string): string {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
  const parts = encrypted.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Encrypt OAuth token data before storing in database.
 * Returns hex string: iv:authTag:ciphertext
 */
export function encryptTokens(data: TokenData): string {
  return encryptString(JSON.stringify(data));
}

/**
 * Decrypt stored OAuth token data.
 * Throws if decryption fails (tampered data or wrong key).
 */
export function decryptTokens(encrypted: string): TokenData {
  return JSON.parse(decryptString(encrypted)) as TokenData;
}

/**
 * Verify Meta webhook signature.
 * X-Hub-Signature-256: sha256=<hex>
 */
export function verifyMetaSignature(
  body: string,
  signature: string | null,
  appSecret: string
): boolean {
  if (!signature) return false;

  const expected = `sha256=${createHmac("sha256", appSecret)
    .update(body, "utf8")
    .digest("hex")}`;

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
