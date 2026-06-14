// The license brain: resolves the instance token, verifies it against the seller
// JWKS, derives the tier/feature state, persists it, and answers feature checks.
// This is the single entry point the rest of the app uses (hasFeature / requireFeature).

import { env } from "@/lib/env";
import { verifyLicense, hostFromUrl, type JwksKey, type Claims } from "@/lib/license/format";
import { getJwks, parseJwksJson } from "@/lib/license/jwks";
import { getRevocations } from "@/lib/license/revocation";
import { tierFeatures, featureArea, proMessage, LIMITS, type Feature, type LimitKind } from "@/lib/license/features";
import { normalizeTier } from "@/lib/license/tiers";
import { AREAS, slugAreas, isArea, type Area } from "@/lib/license/areas";
import * as store from "@/lib/license/store";

export type { LicenseStatus } from "@/lib/license/store";

export interface LicenseState {
  status: store.LicenseStatus;
  tier: string | null;
  /** Feature keys entitled by BOTH the tier AND the entitled areas (see entitledFeatures). */
  features: Set<Feature>;
  /** Areas entitled by the verified token (the second gate dimension). */
  products: Set<Area>;
  expiresAt: Date | null;
  source: "db" | "env" | "none";
  upgradeUrl: string;
}

/**
 * The features entitled by a license: a feature is granted only when the tier meets its minTier AND
 * its area is entitled (core is always entitled). Area entitlement is token-derived (deriveProducts),
 * NOT registry-derived — so lowering a feature's minTier in the registry alone never unlocks a
 * publishing/replies feature whose area the verified token doesn't grant. Pure + exported for tests.
 */
export function entitledFeatures(tier: string | null, products: Set<Area>): Set<Feature> {
  const out = new Set<Feature>();
  for (const key of tierFeatures(tier)) {
    const area = featureArea(key);
    if (area === "core" || products.has(area)) out.add(key);
  }
  return out;
}

/**
 * Areas a verified token entitles. An explicit `products` claim is authoritative (the signed token
 * decides); otherwise derive from the product slug; otherwise all-access (current/legacy tokens with
 * neither → zero behaviour change on day one). `core` is always included.
 */
export function deriveProducts(claims: Claims): Set<Area> {
  if (claims.products && claims.products.length) {
    const s = new Set<Area>(["core"]);
    for (const p of claims.products) if (isArea(p)) s.add(p);
    return s;
  }
  return slugAreas(claims.product) ?? new Set<Area>(AREAS);
}

export interface RefreshOpts {
  fetchImpl?: (url: string) => Promise<Response>;
  now?: number; // epoch seconds, for token exp comparison
}

const CACHE_TTL_MS = 60_000;
let cache: { state: LicenseState; at: number } | null = null;
let nowMsImpl: () => number = () => Date.now();

/** Test seam: override the wall clock used for cache freshness. */
export function __setNowMs(fn: () => number): void {
  nowMsImpl = fn;
}

export function invalidateLicenseCache(): void {
  cache = null;
}

function freeState(source: "db" | "env" | "none", status: store.LicenseStatus): LicenseState {
  return { status, tier: null, features: new Set(), products: new Set(), expiresAt: null, source, upgradeUrl: env.LICENSE_UPGRADE_URL };
}

/** The instance's own public host for per-domain license binding: explicit LICENSE_DOMAIN, else
 *  the host of APP_URL. Empty when neither yields a host — a domain-bound token then fails closed. */
function instanceHost(): string {
  return (env.LICENSE_DOMAIN || hostFromUrl(env.APP_URL) || "").trim().toLowerCase();
}

/** A human, UI-facing reason a pasted/stored token was rejected (the raw machine reason is kept
 *  separately for the API/details). Centralised so the panel and the REST route stay consistent. */
export function licenseRejectionMessage(reason: string | undefined): string {
  switch (reason) {
    case "wrong_domain":
      return "This license is for a different domain.";
    case "wrong_product":
      return "This license is for a different product.";
    case "expired":
      return "This license has expired.";
    case "revoked":
      return "This license has been revoked.";
    case "malformed":
    case "unknown_kid":
    case "bad_signature":
      return "This license token is invalid.";
    case "jwks_error":
      return "Couldn't reach the license server — please try again.";
    default:
      return "License rejected.";
  }
}

async function jwksFallback(): Promise<JwksKey[]> {
  return [...parseJwksJson(env.SELLF_JWKS_FALLBACK), ...(await store.readJwksSnapshot())];
}

/** True when this token's order has been revoked by the seller (refund, abuse, …). Fails OPEN:
 *  an unreachable CRL never revokes a valid token. Disabled when no revocation URL is set. */
async function isRevoked(order: string, opts: RefreshOpts): Promise<boolean> {
  if (!env.LICENSE_REVOCATION_URL) return false;
  const { orders } = await getRevocations({ url: env.LICENSE_REVOCATION_URL, fetchImpl: opts.fetchImpl });
  return orders.has(order);
}

/** Re-resolves and re-verifies the license from scratch, persists, and caches. */
export async function refreshLicense(opts: RefreshOpts = {}): Promise<LicenseState> {
  const { token, source } = await store.resolveTokenSource();
  if (!token) {
    await store.persistLicenseState({ status: "none", tier: null, expiresAt: null, lastError: null });
    return cacheState(freeState(source, "none"));
  }

  let keys: JwksKey[];
  let fresh = false;
  try {
    ({ keys, fresh } = await getJwks({
      url: env.LICENSE_JWKS_URL,
      fetchImpl: opts.fetchImpl,
      fallbackKeys: await jwksFallback(),
    }));
  } catch {
    // No keys anywhere (cold boot during a full outage). Don't revoke loudly —
    // record the error and degrade to free until keys are reachable again.
    await store.persistLicenseState({ status: "invalid", tier: null, expiresAt: null, lastError: "jwks_error" });
    return cacheState(freeState(source, "invalid"));
  }
  if (fresh) await store.writeJwksSnapshot(keys);

  const res = await verifyLicense(token, keys, { productSlug: env.LICENSE_PRODUCT_SLUG, now: opts.now, expectedHost: instanceHost() });
  if (res.valid) {
    if (await isRevoked(res.claims.order, opts)) {
      await store.persistLicenseState({ status: "invalid", tier: null, expiresAt: null, lastError: "revoked" });
      return cacheState(freeState(source, "invalid"));
    }
    const expiresAt = res.claims.exp ? new Date(res.claims.exp * 1000) : null;
    await store.persistLicenseState({ status: "active", tier: res.tier, expiresAt, lastError: null });
    // products is re-derived from the token on every refresh — never persisted — so the store schema
    // is unchanged (one-migration rule) and a tampered DB row can't grant areas the token doesn't.
    const products = deriveProducts(res.claims);
    return cacheState({
      status: "active",
      tier: res.tier,
      features: entitledFeatures(res.tier, products),
      products,
      expiresAt,
      source,
      upgradeUrl: env.LICENSE_UPGRADE_URL,
    });
  }

  const status: store.LicenseStatus = res.reason === "expired" ? "expired" : "invalid";
  await store.persistLicenseState({ status, tier: null, expiresAt: null, lastError: res.reason });
  return cacheState(freeState(source, status));
}

function cacheState(state: LicenseState): LicenseState {
  cache = { state, at: nowMsImpl() };
  return state;
}

export async function getInstanceLicense(opts: RefreshOpts = {}): Promise<LicenseState> {
  if (cache && nowMsImpl() - cache.at < CACHE_TTL_MS) return cache.state;
  return refreshLicense(opts);
}

export async function hasFeature(feature: Feature, opts?: RefreshOpts): Promise<boolean> {
  return (await getInstanceLicense(opts)).features.has(feature);
}

/** The areas the instance license currently entitles. */
export async function entitledProducts(opts?: RefreshOpts): Promise<Set<Area>> {
  return (await getInstanceLicense(opts)).products;
}

export class ProRequiredError extends Error {
  constructor(public readonly feature: Feature) {
    // Area-aware reason: names whether a publishing/replies product (not just a tier) is needed.
    super(proMessage(feature));
    this.name = "ProRequiredError";
  }
}

export async function requireFeature(feature: Feature, opts?: RefreshOpts): Promise<void> {
  if (!(await hasFeature(feature, opts))) throw new ProRequiredError(feature);
}

// ── tier count-limits (ported from PostStack: limitFor / assertWithinLimit) ───────────────────────

/** The current instance tier (null = free). One license per instance → one verdict for all. */
export async function currentTier(opts?: RefreshOpts): Promise<string | null> {
  return (await getInstanceLicense(opts)).tier;
}

/** The numeric limit for a tier+kind (Infinity = unlimited). */
export function limitFor(tier: string | null | undefined, kind: LimitKind): number {
  return LIMITS[normalizeTier(tier)][kind];
}

/** Thrown when creating one more of `kind` would exceed the tier's count limit. Mapped to 402. */
export class LimitExceededError extends Error {
  constructor(public readonly kind: LimitKind, public readonly limit: number) {
    const noun = kind === "apiKeys" ? "API key(s)" : "brand(s)";
    super(`Your plan allows ${limit} ${noun} — upgrade for more.`);
    this.name = "LimitExceededError";
  }
}

/** Hard gate on a count limit — `currentCount` = how many already exist; throws if creating one
 *  more would exceed the tier's limit. */
export function assertWithinLimit(tier: string | null | undefined, kind: LimitKind, currentCount: number): void {
  const limit = limitFor(tier, kind);
  if (currentCount >= limit) throw new LimitExceededError(kind, limit);
}

export interface SetLicenseResult {
  ok: boolean;
  reason?: string;
  state: LicenseState;
}

/** Panel entry point: verify a pasted token, store it (encrypted) on success. */
export async function setLicense(token: string, opts: RefreshOpts = {}): Promise<SetLicenseResult> {
  let keys: JwksKey[];
  try {
    const got = await getJwks({ url: env.LICENSE_JWKS_URL, fetchImpl: opts.fetchImpl, fallbackKeys: await jwksFallback() });
    keys = got.keys;
    if (got.fresh) await store.writeJwksSnapshot(keys);
  } catch {
    invalidateLicenseCache();
    return { ok: false, reason: "jwks_error", state: freeState("none", "invalid") };
  }

  const res = await verifyLicense(token, keys, { productSlug: env.LICENSE_PRODUCT_SLUG, now: opts.now, expectedHost: instanceHost() });
  if (!res.valid) {
    // Reject without storing an unusable token; record why for the panel.
    await store.persistLicenseState({ status: "invalid", tier: null, expiresAt: null, lastError: res.reason });
    invalidateLicenseCache();
    return { ok: false, reason: res.reason, state: freeState("none", "invalid") };
  }

  if (await isRevoked(res.claims.order, opts)) {
    await store.persistLicenseState({ status: "invalid", tier: null, expiresAt: null, lastError: "revoked" });
    invalidateLicenseCache();
    return { ok: false, reason: "revoked", state: freeState("none", "invalid") };
  }

  const expiresAt = res.claims.exp ? new Date(res.claims.exp * 1000) : null;
  await store.persistLicenseState({ token, status: "active", tier: res.tier, expiresAt, lastError: null });
  invalidateLicenseCache();
  const state = await getInstanceLicense(opts);
  return { ok: true, state };
}

/** Panel entry point: drop the stored token, reverting to env/free. */
export async function clearLicense(opts: RefreshOpts = {}): Promise<LicenseState> {
  await store.clearStoredToken();
  invalidateLicenseCache();
  return refreshLicense(opts);
}
