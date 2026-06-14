// Fixed e2e license keypair (committed test fixture). A P-256 ECDSA keypair generated ONCE; the
// public SPKI PEM is served to the server via SELLF_JWKS_FALLBACK (see playwright.config.ts) and the
// private PKCS8 PEM signs PRO tokens in-test. Mirrors src/lib/license/__fixtures__/keys.ts: it signs
// the Sellf wire format `payloadB64url.sigB64url` and converts WebCrypto raw r||s → ASN.1 DER, which
// the verifier (src/lib/license/format.ts) requires.
//
// This is PUBLIC test key material — it never touches production and is intentionally committed.

import { createSign } from "crypto";

export const E2E_KID = "e2e-kid";

// PKCS8 PEM — the private signing key (test-only).
export const E2E_PRIVATE_PKCS8_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgEfko2y5MPujlcJnM
c7xIGUslBXtQT0qgUUmqBO6IJv6hRANCAATwT9oE0aETFloXdtLBsd93kunrc4Tf
L6vQIeZR2wmid3YuC9V7a3zSidIP24/pfAbXux9j6mXcS+CR/DUDlYM5
-----END PRIVATE KEY-----
`;

// SPKI PEM — the matching public key, fed to the server as the JWKS fallback.
export const E2E_PUBLIC_SPKI_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8E/aBNGhExZaF3bSwbHfd5Lp63OE
3y+r0CHmUdsJond2LgvVe2t80onSD9uP6XwG17sfY+pl3Evgkfw1A5WDOQ==
-----END PUBLIC KEY-----
`;

/** The JWKS-fallback JSON the server expects (`{ keys: [{ kid, alg, pem }] }`, PEM-based — see
 *  src/lib/license/jwks.ts parseJwksJson). This goes into SELLF_JWKS_FALLBACK. */
export function jwksFallbackJson(): string {
  return JSON.stringify({ keys: [{ kid: E2E_KID, alg: "ES256", pem: E2E_PUBLIC_SPKI_PEM }] });
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface E2EClaims {
  v: number;
  kid: string;
  product: string;
  email: string;
  order: string;
  tier: string | null;
  iat: number;
  exp: number | null;
  products?: string[];
}

/**
 * Sign a Sellf-style license token. Node's createSign("SHA256") over ECDSA emits an ASN.1 DER
 * signature — exactly the wire format the verifier consumes (it converts DER → raw before
 * crypto.subtle.verify). Token = `base64url(JSON(claims)).base64url(DER signature)`.
 */
export function signToken(claims: E2EClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const der = createSign("SHA256").update(payload).sign(E2E_PRIVATE_PKCS8_PEM);
  return `${payload}.${b64url(der)}`;
}

/** A maximal-unlock PRO token: tier business + all three product areas → every feature, incl.
 *  multi_workspace (business-only). product must match LICENSE_PRODUCT_SLUG (poststack). */
export function mintProToken(now = Math.floor(Date.now() / 1000)): string {
  return signToken({
    v: 1,
    kid: E2E_KID,
    product: "poststack",
    email: "e2e@example.com",
    order: "ord_e2e_pro",
    tier: "business",
    products: ["core", "publishing", "replies"],
    iat: now,
    exp: now + 3600,
  });
}
