import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEndpoints } from "@/db/schema";
import { encryptString, decryptString } from "@/lib/crypto";
import { assertValidHeaderMap, encryptHeaderMap, decryptHeaderMap, type HeaderMap } from "@/lib/webhooks/header-map";
import { ApiError } from "@/lib/api/response";
import { isKnownEventType } from "@/lib/events";
import { classifyIp } from "@/lib/net/ip-classify";

export type { HeaderMap };
// Adds the decrypted `headers` map alongside the raw (ciphertext) `custom_headers_encrypted` column —
// callers that only need to know header NAMES (the edit form) or actual values (the dispatcher) both
// read `headers`; nothing needs to touch the ciphertext column directly outside this module.
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect & { headers: HeaderMap };
const SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

/** A signing secret: `whsec_` + 48 hex chars. Used to HMAC-sign outbound deliveries. */
function newSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * Signing secrets are stored AES-256-GCM-encrypted at rest (like OAuth tokens). The service layer is
 * the single boundary — it encrypts on write and hands the decrypted plaintext back to callers (the
 * dashboard display + the dispatcher's signer), so a read-only DB leak never exposes a usable secret.
 */
function decryptEndpoint(row: typeof webhookEndpoints.$inferSelect): WebhookEndpoint {
  return {
    ...row,
    secret: decryptString(row.secret, [`ws:${row.workspace_id}`, "webhook_endpoints.secret", row.id]),
    secret_secondary: row.secret_secondary ? decryptString(row.secret_secondary, [`ws:${row.workspace_id}`, "webhook_endpoints.secret_secondary", row.id]) : null,
    headers: decryptHeaderMap(row.custom_headers_encrypted, [`ws:${row.workspace_id}`, "webhook_endpoints.custom_headers_encrypted", row.id]),
  };
}

/**
 * http/https + parseable. Throws ApiError(invalid_request) otherwise.
 *
 * Create-time validation is intentionally LIGHT — no DNS resolution — so a transient-DNS,
 * not-yet-live, or internal-with-flag endpoint is not rejected up front. The AUTHORITATIVE SSRF
 * guard runs at delivery (DNS-resolved + pinned, secure-by-default). The one exception: if the host
 * is a literal IP in a never-allowed range (cloud-metadata/link-local, unspecified, or multicast),
 * reject immediately for clear UX feedback. A plain hostname classifies as "unknown" (not an IP) and
 * is always allowed here; `private`/`loopback`/`cgnat` literals stay permissive (allowed-with-flag at
 * delivery).
 */
function assertValidUrl(url: string): void {
  if (url.includes("\0")) throw new ApiError("invalid_request", "Endpoint URL must not contain NUL characters.", 422);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError("invalid_request", "Endpoint URL is not a valid URL", 422);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError("invalid_request", "Endpoint URL must be http or https", 422);
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 literal brackets
  const category = classifyIp(host);
  if (category === "link_local" || category === "unspecified" || category === "multicast") {
    throw new ApiError("invalid_request", "Endpoint URL points at a blocked address", 422);
  }
}

/** Every entry must be a known catalog event type. Empty array = subscribe to all. */
function assertValidEventTypes(eventTypes: string[]): void {
  const bad = eventTypes.filter((t) => !isKnownEventType(t));
  if (bad.length > 0) {
    const message = `Unknown event type(s): ${bad.join(", ")}`;
    throw new ApiError("invalid_request", message, 422, [{ path: "event_types", message }]);
  }
}

export async function createEndpoint(
  workspaceId: string,
  input: { url: string; eventTypes?: string[]; headers?: HeaderMap; extraFields?: Record<string, unknown> },
): Promise<WebhookEndpoint> {
  const eventTypes = input.eventTypes ?? [];
  assertValidHeaderMap(input.headers);
  assertValidUrl(input.url);
  assertValidEventTypes(eventTypes);
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      workspace_id: workspaceId,
      url: input.url,
      secret: encryptString(newSecret()),
      event_types: [...new Set(eventTypes)],
      active: true,
      custom_headers_encrypted: encryptHeaderMap(input.headers),
      extra_payload_fields: input.extraFields ?? {},
    })
    .returning();
  return decryptEndpoint(row!); // returns the freshly-minted plaintext once
}

/** A workspace's endpoints, newest first, with decrypted secrets (the dashboard display needs them). */
export async function listEndpoints(workspaceId: string): Promise<WebhookEndpoint[]> {
  const rows = await db.query.webhookEndpoints.findMany({
    where: eq(webhookEndpoints.workspace_id, workspaceId),
    orderBy: [desc(webhookEndpoints.created_at)],
  });
  return rows.map(decryptEndpoint);
}

/** One endpoint, scoped to its workspace. The dispatcher passes the delivery's workspace_id so an
 *  endpoint is never resolved cross-tenant. */
export async function getEndpoint(workspaceId: string, id: string): Promise<WebhookEndpoint | undefined> {
  const row = await db.query.webhookEndpoints.findFirst({
    where: and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId)),
  });
  return row ? decryptEndpoint(row) : undefined;
}

export async function updateEndpoint(
  workspaceId: string,
  id: string,
  patch: {
    url?: string;
    eventTypes?: string[];
    active?: boolean;
    /** Omitted = leave existing headers untouched; {} explicitly clears them (never echoed back, so a
     *  no-op read-modify-write can't accidentally wipe a value it never saw). */
    headers?: HeaderMap;
    extraFields?: Record<string, unknown>;
  },
): Promise<WebhookEndpoint> {
  const existing = await getEndpoint(workspaceId, id);
  if (!existing) throw new ApiError("not_found", "Webhook endpoint not found", 404);

  assertValidHeaderMap(patch.headers);
  const set: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (patch.url !== undefined) {
    assertValidUrl(patch.url);
    set.url = patch.url;
  }
  if (patch.eventTypes !== undefined) {
    assertValidEventTypes(patch.eventTypes);
    set.event_types = [...new Set(patch.eventTypes)];
  }
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.headers !== undefined) set.custom_headers_encrypted = encryptHeaderMap(patch.headers);
  if (patch.extraFields !== undefined) set.extra_payload_fields = patch.extraFields;

  if (Object.keys(set).length === 0) return existing;

  const [row] = await db
    .update(webhookEndpoints)
    .set(set)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId)))
    .returning();
  if (!row) throw new ApiError("not_found", "Webhook endpoint not found", 404);
  return decryptEndpoint(row);
}

/**
 * Rotate the signing secret: the current `secret` becomes `secret_secondary` (a grace window so
 * in-flight verifications using the old secret still pass), and a fresh `secret` is minted. Any older
 * secondary is dropped — only the immediately-previous secret stays valid.
 */
export async function rotateSecret(workspaceId: string, id: string): Promise<WebhookEndpoint> {
  const where = and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId));
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ secret: webhookEndpoints.secret }).from(webhookEndpoints).where(where).for("update");
    if (!existing) throw new ApiError("not_found", "Webhook endpoint not found", 404);
    const previousSecret = decryptString(existing.secret, [`ws:${workspaceId}`, "webhook_endpoints.secret", id]);
    const [row] = await tx.update(webhookEndpoints).set({
      secret: encryptString(newSecret()),
      secret_secondary: encryptString(previousSecret),
      secret_secondary_expires_at: new Date(Date.now() + SECRET_GRACE_MS),
    }).where(where).returning();
    return decryptEndpoint(row!);
  });
}

/** Delete an endpoint and its deliveries (delivery FK references the endpoint). */
export async function deleteEndpoint(workspaceId: string, id: string): Promise<void> {
  const [deleted] = await db.delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId)))
    .returning({ id: webhookEndpoints.id });
  if (!deleted) throw new ApiError("not_found", "Webhook endpoint not found", 404);
}
