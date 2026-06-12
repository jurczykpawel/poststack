import { hasFeature } from "@/lib/license/gate";
import { proMessage, type Feature } from "@/lib/license/features";
import { ApiErrors } from "@/lib/api/response";
import { env } from "@/lib/env";

/**
 * Returns a 402 PRO_REQUIRED response when the instance license does not grant
 * `feature`, or null when it does. Handlers gate with:
 *
 *   const gate = await proGate("contacts_crm");
 *   if (gate) return gate;
 */
export async function proGate(feature: Feature): Promise<Response | null> {
  if (await hasFeature(feature)) return null;
  return ApiErrors.proRequired(feature, env.LICENSE_UPGRADE_URL, proMessage(feature));
}
