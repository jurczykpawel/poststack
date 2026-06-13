/** Compact signed relative time: "in 5d" / "in 3h" / "12d ago" / "2m ago". */
export function relTime(at: Date): string {
  const ms = at.getTime() - Date.now();
  const abs = Math.abs(ms);
  const day = 86400000;
  let v: string;
  if (abs < 3600000) v = `${Math.max(1, Math.round(abs / 60000))}m`;
  else if (abs < day) v = `${Math.round(abs / 3600000)}h`;
  else v = `${Math.round(abs / day)}d`;
  return ms >= 0 ? `in ${v}` : `${v} ago`;
}

/** Absolute timestamp, 24h, locale-stable (e.g. "10 Jun 2026, 14:05"). */
export function fmtDate(at: Date): string {
  return at.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
