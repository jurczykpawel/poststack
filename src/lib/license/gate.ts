// The license brain: resolves the instance token, verifies it against the seller
// JWKS, derives the tier/feature state, persists it, and answers feature checks.
// This is the single entry point the rest of the app uses (hasFeature / requireFeature).

import { env } from "@/lib/env";
import { verifyLicense, type JwksKey } from "@/lib/license/format";
import { getJwks, parseJwksJson } from "@/lib/license/jwks";
import { tierFeatures, type Feature } from "@/lib/license/features";
import * as store from "@/lib/license/store";

export type { LicenseStatus } from "@/lib/license/store";

export interface LicenseState {
  status: store.LicenseStatus;
  tier: string | null;
  features: Set<Feature>;
  expiresAt: Date | null;
  source: "db" | "env" | "none";
  upgradeUrl: string;
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
  return { status, tier: null, features: new Set(), expiresAt: null, source, upgradeUrl: env.LICENSE_UPGRADE_URL };
}

async function jwksFallback(): Promise<JwksKey[]> {
  return [...parseJwksJson(env.SELLF_JWKS_FALLBACK), ...(await store.readJwksSnapshot())];
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

  const res = await verifyLicense(token, keys, { productSlug: env.LICENSE_PRODUCT_SLUG, now: opts.now });
  if (res.valid) {
    const expiresAt = res.claims.exp ? new Date(res.claims.exp * 1000) : null;
    await store.persistLicenseState({ status: "active", tier: res.tier, expiresAt, lastError: null });
    return cacheState({
      status: "active",
      tier: res.tier,
      features: tierFeatures(res.tier),
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

export class ProRequiredError extends Error {
  constructor(public readonly feature: Feature) {
    super(`PRO feature required: ${feature}`);
    this.name = "ProRequiredError";
  }
}

export async function requireFeature(feature: Feature, opts?: RefreshOpts): Promise<void> {
  if (!(await hasFeature(feature, opts))) throw new ProRequiredError(feature);
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

  const res = await verifyLicense(token, keys, { productSlug: env.LICENSE_PRODUCT_SLUG, now: opts.now });
  if (!res.valid) {
    // Reject without storing an unusable token; record why for the panel.
    await store.persistLicenseState({ status: "invalid", tier: null, expiresAt: null, lastError: res.reason });
    invalidateLicenseCache();
    return { ok: false, reason: res.reason, state: freeState("none", "invalid") };
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
