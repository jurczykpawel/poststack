// Fixed, non-secret telemetry constants. These are part of the product wire format (the project
// identifier the receiver buckets on, and the pepper mixed into the one-way instance identifiers),
// not deployment config — so they live in source, not env. The pepper is versioned so the hashing
// scheme can be rotated later (a new value yields a fresh identifier namespace).
export const TELEMETRY_PROJECT = "poststack";
export const TELEMETRY_HASH_PEPPER = "poststack-telemetry-v1";
