export const INSIGHT_RANGES = [7, 30] as const;

export const shiftInsightDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function providerToday(timeZone = "UTC", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Instant at which a provider calendar day starts in the connector's day zone. */
export function providerDayStart(day: string, timeZone = "UTC"): string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offset = (time: number) => {
    const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - time;
  };
  const midnight = Date.parse(`${day}T00:00:00Z`);
  return new Date(midnight - offset(midnight - offset(midnight))).toISOString();
}

