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
    created_at: ep.created_at,
    updated_at: ep.updated_at,
  };
}

/** Creation/rotation view: the public shape PLUS the freshly-minted plaintext signing secret, shown once. */
export function serializeEndpointWithSecret(ep: WebhookEndpoint) {
  return { ...serializeEndpoint(ep), secret: ep.secret };
}
