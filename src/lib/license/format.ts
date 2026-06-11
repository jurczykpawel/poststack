// Offline verification of Sellf-issued license tokens. Ported from the captions
// web verifier (apps/web/functions/_lib/sellf-license.ts) — same wire format and
// crypto, runtime-agnostic WebCrypto so it runs under both Bun and Node (Vitest).
//
// Token: `payloadB64url.sigB64url`. payload = base64url(JSON(claims)). The
// signature is ECDSA P-256 / SHA-256 over the ASCII bytes of the payload segment.
//
// Interop note: Sellf signs with node `createSign("SHA256").sign()`, emitting an
// ASN.1 DER signature; WebCrypto's `verify` wants raw IEEE-P1363 r||s, so we
// convert DER -> raw before verifying. The public key arrives as SPKI PEM and is
// converted PEM -> DER for importKey("spki", …).
//
// Seller binding is enforced upstream by using a seller-scoped JWKS URL (only the
// TSA seller's keys are fetched); product binding is enforced here via claims.product.

export interface Claims {
  v: number;
  kid: string;
  product: string;
  email: string;
  order: string;
  tier: string | null;
  iat: number;
  exp: number | null;
}

export interface JwksKey {
  kid: string;
  alg: string;
  pem: string;
}

export type VerifyResult =
  | { valid: true; tier: string | null; claims: Claims }
  | {
      valid: false;
      reason: "malformed" | "unknown_kid" | "bad_signature" | "expired" | "wrong_product";
    };

function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseClaims(token: string): Claims | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(token.slice(0, dot)));
    return JSON.parse(json) as Claims;
  } catch {
    return null;
  }
}

// PEM (SPKI) -> DER bytes for importKey("spki", …).
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return b64urlToBytes(body);
}

// ASN.1 DER ECDSA signature (SEQUENCE{ INTEGER r, INTEGER s }) -> raw r||s
// (64 bytes for P-256). Strips minimal-encoding leading zeros and left-pads.
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  let offset = 2; // skip SEQUENCE tag (0x30) + length byte
  if (der[1] & 0x80) offset += der[1] & 0x7f; // long-form length
  const readInt = (): Uint8Array => {
    if (der[offset] !== 0x02) throw new Error("bad DER INTEGER");
    let len = der[offset + 1];
    let start = offset + 2;
    while (len > 0 && der[start] === 0x00) {
      start++;
      len--;
    }
    offset = start + len;
    return der.slice(start, start + len);
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

async function verifyTokenSignature(token: string, publicKeyPem: string): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  try {
    const signed = new TextEncoder().encode(token.slice(0, dot));
    const raw = derToRaw(b64urlToBytes(token.slice(dot + 1)));
    const key = await crypto.subtle.importKey(
      "spki",
      pemToDer(publicKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed);
  } catch {
    return false;
  }
}

/**
 * Verifies a Sellf license token against the given JWKS keys. JWKS fetching and
 * caching live in jwks.ts; this function is pure given its key set.
 */
export async function verifyLicense(
  token: string,
  jwksKeys: JwksKey[],
  opts: { productSlug: string; now?: number },
): Promise<VerifyResult> {
  const claims = parseClaims(token);
  if (!claims) return { valid: false, reason: "malformed" };

  const jwk = jwksKeys.find((k) => k.kid === claims.kid);
  if (!jwk) return { valid: false, reason: "unknown_kid" };
  if (!(await verifyTokenSignature(token, jwk.pem))) return { valid: false, reason: "bad_signature" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return { valid: false, reason: "expired" };
  if (claims.product !== opts.productSlug) return { valid: false, reason: "wrong_product" };

  return { valid: true, tier: claims.tier, claims };
}
