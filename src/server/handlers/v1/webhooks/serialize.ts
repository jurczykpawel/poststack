import type { WebhookEndpoint } from "@/lib/webhooks/endpoints";

/**
 * Public view of an endpoint. The signing secret is deliberately omitted: like an API key it is
 * revealed only once, at creation/rotation (the receiver stores it then). Routine GET/PATCH responses
 * never echo it back, so a leaked listing can't hand an attacker a usable signing secret.
 */
export function serializeEndpoint(ep: WebhookEndpoint) {
  return {
    id: ep.id,
    url: ep.url,
    event_types: ep.event_types,
    active: ep.active,
    // Custom header NAMES only (never values) — same "what's configured without leaking secrets"
    // pattern as the alert webhook's edit form. Extra payload fields are not secret, so they're
    // echoed back in full (lets an integrator GET the endpoint to see what it's currently sending).
    header_names: Object.keys(ep.headers),
    extra_payload_fields: ep.extra_payload_fields,
    created_at: ep.created_at,
    updated_at: ep.updated_at,
  };
}

/** Creation/rotation view: the public shape PLUS the freshly-minted plaintext signing secret, shown once. */
export function serializeEndpointWithSecret(ep: WebhookEndpoint) {
  return { ...serializeEndpoint(ep), secret: ep.secret };
}
