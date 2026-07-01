/**
 * Pure (no-IO) helpers that shape an outbound webhook body per workspace customization, mirroring
 * Sellf's webhook_endpoints customization:
 *  - field selection over a standard body,
 *  - extra top-level fields with {{placeholder}} substitution.
 * Substitution happens only at JSON string leaves, so a value can never break out of its position.
 * Shared by the alert webhook (notifications/alert.ts) and outbound webhook endpoints (webhooks/dispatch.ts).
 */

export type PlaceholderContext = Record<string, string>;

export interface PayloadCustomization {
  field_selection?: string[] | null;
  extra_payload_fields?: Record<string, unknown> | null;
}

/** Keep only whitelisted keys; null/undefined selection = identity (all fields). */
export function selectFields(
  body: Record<string, unknown>,
  selection: string[] | null | undefined,
): Record<string, unknown> {
  if (!selection) return body;
  const allowed = new Set(selection);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

/** Resolve {{key}} tokens in string leaves from ctx; unknown → ''. Recurses objects/arrays. */
export function renderTemplate(fields: unknown, ctx: PlaceholderContext): unknown {
  if (typeof fields === "string") {
    return fields.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => ctx[key] ?? "");
  }
  if (Array.isArray(fields)) return fields.map((f) => renderTemplate(f, ctx));
  if (fields && typeof fields === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      out[k] = renderTemplate(v, ctx);
    }
    return out;
  }
  return fields;
}

/**
 * Compose the body actually POSTed: the (optionally field-selected) standard body plus the rendered
 * extra fields. Extra fields win on key collision so an operator can override a standard field
 * (e.g. shape an email `subject`/`to` from {{placeholder}}s).
 */
export function buildCustomizedBody(
  standard: Record<string, unknown>,
  customization: PayloadCustomization,
  ctx: PlaceholderContext,
): Record<string, unknown> {
  const selected = selectFields(standard, customization.field_selection);
  const extra = customization.extra_payload_fields
    ? (renderTemplate(customization.extra_payload_fields, ctx) as Record<string, unknown>)
    : {};
  return { ...selected, ...extra };
}
