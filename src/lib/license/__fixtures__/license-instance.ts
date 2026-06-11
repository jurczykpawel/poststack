// Test helper: license the instance at a given tier so PRO-gated features
// (interactive messages, follow-gate, AI rephrase, sequences, …) are unlocked.
// Warms the JWKS cache + persists an active token, so handlers see the license
// without any network. Call after the app/env are imported in beforeAll.

import { makeTestKey, makeClaims } from "./keys";

const KID = "test-license-kid";

export async function licenseInstance(tier = "pro"): Promise<void> {
  const gate = await import("@/lib/license/gate");
  const jwks = await import("@/lib/license/jwks");
  const { env } = await import("@/lib/env");
  const key = await makeTestKey(KID);
  const token = await key.sign(makeClaims({ kid: KID, tier }));
  const fetchImpl = async () => new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
  // Each call mints a fresh key under the same kid; clear any stale cached JWKS so the
  // new token verifies against THIS key (the 5-min fresh cache would otherwise win).
  jwks.__resetJwksCache();
  await jwks.getJwks({ url: env.LICENSE_JWKS_URL, fetchImpl, now: Date.now() });
  await gate.setLicense(token, { fetchImpl });
}
