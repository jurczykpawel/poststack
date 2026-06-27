// Coarsening helpers — collapse high-entropy host facts into low-cardinality buckets at the sender,
// so the telemetry envelope carries no near-unique deployment fingerprint (k-anonymity over a small
// fleet). Raw cpu/mem/runtime values must never leave the instance.

/** Total memory (MB) → a coarse GB band. */
export function memBucket(mb: number): string {
  const gb = mb / 1024;
  if (gb < 1) return "<1G";
  if (gb < 2) return "1-2";
  if (gb < 4) return "2-4";
  if (gb < 8) return "4-8";
  if (gb < 16) return "8-16";
  if (gb < 32) return "16-32";
  return "32+";
}

/** CPU core count → a coarse band. */
export function cpuBucket(n: number): string {
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n <= 4) return "3-4";
  if (n <= 8) return "5-8";
  return "9+";
}

/** A semver-ish version string → its major component only ("v22.4.1" → "22"). */
export function majorVersion(v: string): string {
  const m = v.replace(/^v/, "").match(/^(\d+)/);
  return m ? m[1] : "unknown";
}
