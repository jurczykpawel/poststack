import type { Platform } from "@/db/schema";
import { getProviderForPlatform, isPublishablePlatform } from "@/lib/providers";
import type { InsightsConnector } from "./types";
export { getMetric, defineMetricCatalog, isDecimal, isDecimalSigned } from "./metric-catalog";

/** Support is platform-scoped even when several platforms share a publishing provider. */
export function getInsightsConnector(platform: Platform): InsightsConnector | undefined {
  if (!isPublishablePlatform(platform)) return undefined;
  return getProviderForPlatform(platform).insights?.(platform);
}
