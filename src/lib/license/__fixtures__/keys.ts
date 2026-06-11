// Test-only helpers that emulate how Sellf issues license tokens, so the
// verifier can be tested offline with a locally generated key pair.
//
// Sellf signs with Node `createSign("SHA256")`, which emits an ASN.1 DER
// signature. WebCrypto's ECDSA sign emits raw IEEE-P1363 r||s, so the fixture
// signer converts raw -> DER to match the real wire format the verifier sees.

import type { Claims, JwksKey } from "@/lib/license/format";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// raw r||s (64 bytes for P-256) -> ASN.1 DER SEQUENCE{ INTEGER r, INTEGER s }.
function rawToDer(raw: Uint8Array): Uint8Array {
  const encodeInt = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0x00) i++; // strip leading zeros, keep one
    let body = Array.from(b.slice(i));
    if (body[0] & 0x80) body = [0x00, ...body]; // high bit set -> positive padding
    return [0x02, body.length, ...body];
  };
  const r = encodeInt(raw.slice(0, 32));
  const s = encodeInt(raw.slice(32, 64));
  const seq = [...r, ...s];
  return new Uint8Array([0x30, seq.length, ...seq]);
}

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export interface TestKey {
  kid: string;
  jwk: JwksKey;
  sign(claims: Claims): Promise<string>;
}

/** Generates a P-256 key pair and returns its JWKS entry plus a Sellf-style token signer. */
export async function makeTestKey(kid = "test-kid-1"): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const pem = derToPem(spki, "PUBLIC KEY");

  return {
    kid,
    jwk: { kid, alg: "ES256", pem },
    async sign(claims: Claims): Promise<string> {
      const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify(claims)));
      const rawSig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(payload),
        ),
      );
      return `${payload}.${bytesToB64url(rawToDer(rawSig))}`;
    },
  };
}

/** A complete, valid-by-default claims object; override fields per test. */
export function makeClaims(overrides: Partial<Claims> = {}): Claims {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    kid: "test-kid-1",
    product: "replystack-pro",
    email: "buyer@example.com",
    order: "ord_test_1",
    tier: "pro",
    iat: nowSec,
    exp: nowSec + 3600,
    ...overrides,
  };
}
