import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  [key: string]: unknown;
}

/**
 * Encrypt OAuth token data before storing in database.
 * Returns hex string: iv:authTag:ciphertext
 */
export function encryptTokens(data: TokenData): string {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(data);
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
 * Decrypt stored OAuth token data.
 * Throws if decryption fails (tampered data or wrong key).
 */
export function decryptTokens(encrypted: string): TokenData {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
  const parts = encrypted.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8")) as TokenData;
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

  const { createHmac, timingSafeEqual } = require("crypto") as typeof import("crypto");
  const expected = `sha256=${createHmac("sha256", appSecret)
    .update(body, "utf8")
    .digest("hex")}`;

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
