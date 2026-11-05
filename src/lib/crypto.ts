import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
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

export type SecretContext = readonly [scope: string, field: string, ...binding: string[]];

function readV2(encrypted: string, context?: SecretContext): string {
  if (encrypted.length > 1398153) throw new Error("Invalid encrypted value length");
  const parts = encrypted.split(".");
  if (parts.length !== 4 || parts[0] !== "ps2" || !/^[A-Za-z0-9_-]{8}$/.test(parts[1])) throw new Error("Invalid encrypted value format");
  if (!context || context.length < 2 || !context.every((v) => typeof v === "string" && v.length > 0) || !/^(instance|ws:.+)$/.test(context[0])) throw new Error("Encryption context required");
  const decode = (value: string): Buffer => {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Invalid encrypted value encoding");
    return bytes;
  };
  const iv = decode(parts[2]), body = decode(parts[3]);
  if (iv.length !== 12 || body.length < 16 || body.length > 1048592) throw new Error("Invalid encrypted value length");
  const previous: unknown = process.env.ENCRYPTION_KEY_PREVIOUS ? JSON.parse(process.env.ENCRYPTION_KEY_PREVIOUS) : [];
  if (!Array.isArray(previous) || previous.length > 16 || !previous.every((v) => typeof v === "string" && v.length >= MIN_KEY_LEN)) throw new Error("Invalid previous encryption keys");
  const keys = new Map<string, Buffer>();
  for (const secret of [requireEncryptionKey(), ...previous]) {
    const derived = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("poststack:ps2"), Buffer.from("aes-256-gcm"), 32));
    const kid = createHmac("sha256", derived).update("kid").digest("base64url").slice(0, 8);
    if (keys.has(kid) && !keys.get(kid)!.equals(derived)) throw new Error("Encryption key identifier collision");
    keys.set(kid, derived);
  }
  const selected = keys.get(parts[1]);
  if (!selected) throw new Error("Encryption key unavailable");
  const decipher = createDecipheriv(ALGORITHM, selected, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(JSON.stringify(["ps2", parts[1], ...context]), "utf8"));
  decipher.setAuthTag(body.subarray(-16));
  return Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]).toString("utf8");
}

/**
 * Decrypt a string produced by encryptString.
 * Throws if decryption fails (tampered data or wrong key).
 */
export function decryptString(encrypted: string, context?: SecretContext): string {
  const mode = process.env.ENCRYPTION_READ_MODE || "legacy-readable";
  if (mode !== "legacy-readable" && mode !== "v2-only") throw new Error("Invalid encryption read mode");
  if (encrypted.startsWith("ps2.")) return readV2(encrypted, context);
  if (encrypted.startsWith("ps") || mode === "v2-only") throw new Error("Unsupported encrypted value format");
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
export function decryptTokens(encrypted: string, context?: SecretContext): TokenData {
  return JSON.parse(decryptString(encrypted, context)) as TokenData;
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

  // Compare BYTE lengths, not UTF-16 .length: a multibyte char in the incoming header could share
  // expected's .length but differ in byte length, making timingSafeEqual throw → uncaught 500 that
  // bypasses clean rejection. Build the buffers first and guard on their byte length.
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;

  return timingSafeEqual(expectedBuf, signatureBuf);
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
