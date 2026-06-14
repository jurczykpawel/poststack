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
  // Optional per-area entitlement. When present (and non-empty) it is the authoritative grant —
  // the signed token, not the local registry, decides which areas unlock. Absent → entitlement is
  // derived from the product slug (else all-access for current/legacy tokens).
  products?: string[];
  // Optional per-domain binding. When present, the token is honoured only on this domain and its
  // subdomains (Policy A: one purchase = one customer's whole domain). Absent → unbound (legacy
  // tokens, dev and e2e keep working; the per-domain lock activates only for domain-bearing tokens).
  domain?: string;
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
      reason: "malformed" | "unknown_kid" | "bad_signature" | "expired" | "wrong_product" | "wrong_domain";
    };

// Normalize a host for comparison: trim, lowercase, drop any :port, strip a leading www.
function normHost(h: string): string {
  return (h ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
}

/**
 * Whether `host` falls under the license's `domain`. Policy A: the licensed domain covers itself
 * AND every subdomain (one purchase = one customer's whole domain). Both sides are normalized
 * (lowercased, port stripped, leading `www.` stripped). An explicit `*.` prefix on the licensed
 * domain is accepted and treated the same as the bare domain. The match respects the dot boundary
 * so `example.com` never matches `badexample.com` or `example.com.evil.com`.
 */
export function domainMatches(licenseDomain: string, host: string): boolean {
  const dom = normHost((licenseDomain ?? "").replace(/^\*\./, ""));
  const h = normHost(host);
  if (!dom || !h) return false;
  return h === dom || h.endsWith("." + dom);
}

/**
 * The lowercased hostname of a URL (the instance's own public host, used as the match target).
 * Falls back to a bare domain string, and returns null for anything that's neither.
 */
export function hostFromUrl(url: string): string | null {
  const s = (url ?? "").trim();
  if (!s) return null;
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return /^[a-z0-9.-]+$/i.test(s) ? s.toLowerCase() : null;
  }
}

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
  // productSlug is the accepted product binding. A comma-separated string (or array) is an
  // allowlist — one instance accepts several products (e.g. an annual + a lifetime PRO variant
  // and the business tier), each a distinct Sellf product/slug, all valid for this install.
  // expectedHost is the instance's own public host (from APP_URL / LICENSE_DOMAIN). A token that
  // carries a `domain` claim is honoured only when expectedHost falls under it; a token WITHOUT a
  // domain claim is unbound and ignores expectedHost (back-compat).
  opts: { productSlug: string | string[]; now?: number; expectedHost?: string },
): Promise<VerifyResult> {
  const claims = parseClaims(token);
  if (!claims) return { valid: false, reason: "malformed" };

  const jwk = jwksKeys.find((k) => k.kid === claims.kid);
  if (!jwk) return { valid: false, reason: "unknown_kid" };
  if (!(await verifyTokenSignature(token, jwk.pem))) return { valid: false, reason: "bad_signature" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return { valid: false, reason: "expired" };
  const allowed = (Array.isArray(opts.productSlug) ? opts.productSlug : opts.productSlug.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(claims.product)) return { valid: false, reason: "wrong_product" };

  // Per-domain binding: a domain-bound token fails CLOSED off its domain (and when the instance
  // host is unknown). An unbound token (no/empty domain claim) skips this check entirely.
  const dom = claims.domain?.trim();
  if (dom) {
    const host = (opts.expectedHost ?? "").trim();
    if (!host || !domainMatches(dom, host)) return { valid: false, reason: "wrong_domain" };
  }

  return { valid: true, tier: claims.tier, claims };
}
