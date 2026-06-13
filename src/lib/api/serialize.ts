const toCamel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Deep snake_case → camelCase on object keys. Arrays are mapped; Dates and non-plain objects pass
 *  through untouched. Applied at the response envelope so DB rows surface as camelCase (the
 *  publishing API convention, alongside RS's existing snake_case endpoints). */
export function camelizeKeys<T>(input: T): T {
  if (Array.isArray(input)) return input.map((v) => camelizeKeys(v)) as unknown as T;
  if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[toCamel(k)] = camelizeKeys(v);
    return out as T;
  }
  return input;
}
