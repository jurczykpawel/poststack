import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { TokenData } from "@/lib/platforms/base";

export type { TokenData };

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const MIN_KEY_LEN = 32;

/**
 * The raw secret behind at-rest encryption. Fails fast with NO silent dev fallback (a public
 * OSS-history default would let anyone decrypt stored tokens). Any passphrase >= 32 chars is
 * accepted and sha256-derived to a 32-byte key — no hex-length constraint. Single source of truth
 * for what "set + well-formed" means; read at call time so a missing key surfaces immediately.
 */
export function requireEncryptionKey(): string {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length < MIN_KEY_LEN) {
    throw new Error(`ENCRYPTION_KEY must be set (>= ${MIN_KEY_LEN} chars)`);
  }
  return k;
}

function key(): Buffer {
  return createHash("sha256").update(requireEncryptionKey()).digest(); // deterministic 32-byte key
}

/**
 * Encrypt an arbitrary string at rest (AES-256-GCM).
 * Returns hex string: iv:authTag:ciphertext
 */
export function encryptString(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);

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
  const parts = encrypted.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, "hex"));
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

/** Accept the webhook if its signature matches ANY of the provided app secrets
 *  (Meta signs FB-app webhooks with META_APP_SECRET and Instagram-Login product
 *  webhooks with INSTAGRAM_APP_SECRET). Timing-safe per secret; empties ignored. */
export function verifyMetaSignatureAny(
  body: string,
  signature: string | null,
  appSecrets: string[]
): boolean {
  return appSecrets.some((s) => s && verifyMetaSignature(body, signature, s));
}
