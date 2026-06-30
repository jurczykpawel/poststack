import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEndpoints, webhookDeliveries } from "@/db/schema";
import { encryptString, decryptString } from "@/lib/crypto";
import { ApiError } from "@/lib/api/response";
import { isKnownEventType } from "@/lib/events";
import { classifyIp } from "@/lib/net/ip-classify";

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;

/** A signing secret: `whsec_` + 48 hex chars. Used to HMAC-sign outbound deliveries. */
function newSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * Signing secrets are stored AES-256-GCM-encrypted at rest (like OAuth tokens). The service layer is
 * the single boundary — it encrypts on write and hands the decrypted plaintext back to callers (the
 * dashboard display + the dispatcher's signer), so a read-only DB leak never exposes a usable secret.
 */
function decryptEndpoint(row: WebhookEndpoint): WebhookEndpoint {
  return {
    ...row,
    secret: decryptString(row.secret),
    secret_secondary: row.secret_secondary ? decryptString(row.secret_secondary) : null,
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
    throw new ApiError("invalid_request", `Unknown event type(s): ${bad.join(", ")}`, 422);
  }
}

export async function createEndpoint(
  workspaceId: string,
  input: { url: string; eventTypes?: string[] },
): Promise<WebhookEndpoint> {
  const eventTypes = input.eventTypes ?? [];
  assertValidUrl(input.url);
  assertValidEventTypes(eventTypes);
  const [row] = await db
    .insert(webhookEndpoints)
    .values({ workspace_id: workspaceId, url: input.url, secret: encryptString(newSecret()), event_types: eventTypes, active: true })
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
  patch: { url?: string; eventTypes?: string[]; active?: boolean },
): Promise<WebhookEndpoint> {
  const existing = await getEndpoint(workspaceId, id);
  if (!existing) throw new ApiError("not_found", "Webhook endpoint not found", 404);

  const set: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (patch.url !== undefined) {
    assertValidUrl(patch.url);
    set.url = patch.url;
  }
  if (patch.eventTypes !== undefined) {
    assertValidEventTypes(patch.eventTypes);
    set.event_types = patch.eventTypes;
  }
  if (patch.active !== undefined) set.active = patch.active;

  if (Object.keys(set).length === 0) return existing;

  const [row] = await db
    .update(webhookEndpoints)
    .set(set)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId)))
    .returning();
  return decryptEndpoint(row!); // secret is untouched here; decrypt so the return matches plaintext
}

/**
 * Rotate the signing secret: the current `secret` becomes `secret_secondary` (a grace window so
 * in-flight verifications using the old secret still pass), and a fresh `secret` is minted. Any older
 * secondary is dropped — only the immediately-previous secret stays valid.
 */
export async function rotateSecret(workspaceId: string, id: string): Promise<WebhookEndpoint> {
  const existing = await getEndpoint(workspaceId, id); // decrypted (plaintext) current secret
  if (!existing) throw new ApiError("not_found", "Webhook endpoint not found", 404);
  const [row] = await db
    .update(webhookEndpoints)
    // Both stored encrypted: the new primary, and the previous primary moved to secondary.
    .set({ secret: encryptString(newSecret()), secret_secondary: encryptString(existing.secret) })
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId)))
    .returning();
  return decryptEndpoint(row!);
}

/** Delete an endpoint and its deliveries (delivery FK references the endpoint). */
export async function deleteEndpoint(workspaceId: string, id: string): Promise<void> {
  const existing = await getEndpoint(workspaceId, id);
  if (!existing) throw new ApiError("not_found", "Webhook endpoint not found", 404);
  await db.transaction(async (tx) => {
    await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.endpoint_id, id));
    await tx.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspace_id, workspaceId)));
  });
}
