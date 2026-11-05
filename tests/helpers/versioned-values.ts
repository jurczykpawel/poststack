import { createCipheriv, createHmac, hkdfSync } from "node:crypto";

export function reference(plaintext: string, secret: string, ctx: readonly string[]): string {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("poststack:ps2"), Buffer.from("aes-256-gcm"), 32));
  const kid = createHmac("sha256", key).update("kid").digest("base64url").slice(0, 8);
  const iv = Buffer.from("000102030405060708090a0b", "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["ps2", kid, ...ctx]), "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `ps2.${kid}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}
