import { defineMetricCatalog } from "../metric-catalog";

/** Exact response examples and inactive recipe reasons live in the fixture manifest. */
export const instagramRecipes = Object.freeze([
  Object.freeze({ key: "reach", metricType: "time_series" as const, grain: "day" as const, provenance: "documentation" as const }),
]);

export const instagramCatalog = defineMetricCatalog([{
  key: "reach", label: "Reach", level: "account", unit: "count", period: "day", grain: "day",
  aggregation: "unique_range", additive: false, definitionVersion: "instagram-reach-v1",
  coverageBasis: "provider_end_time; first interval boundary unconfirmed", cardOrder: 2, chartable: true,
}]);
