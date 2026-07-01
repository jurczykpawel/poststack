import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertWebhooks } from "@/db/schema";
import { encryptHeaderMap, decryptHeaderMap, type HeaderMap } from "@/lib/webhooks/header-map";

export type { HeaderMap };

export interface AlertWebhookConfig {
  url: string;
  enabled: boolean;
  /** Decrypted custom header map (empty when none). */
  headers: HeaderMap;
  extraFields: Record<string, unknown>;
  fieldSelection: string[] | null;
}

export interface AlertWebhookInput {
  url: string;
  enabled?: boolean;
  /** Plaintext header map; encrypted at rest. Pass {} or omit to clear. */
  headers?: HeaderMap;
  extraFields?: Record<string, unknown>;
  fieldSelection?: string[] | null;
}

/**
 * Load a workspace's configured alert webhook (decrypted), or null if none. Used by dispatchAlert to
 * decide whether to send a customized webhook for this workspace (vs the env fallback).
 */
export async function getAlertWebhook(workspaceId: string): Promise<AlertWebhookConfig | null> {
  const row = await db.query.alertWebhooks.findFirst({ where: eq(alertWebhooks.workspace_id, workspaceId) });
  if (!row) return null;
  return {
    url: row.url,
    enabled: row.enabled,
    headers: decryptHeaderMap(row.custom_headers_encrypted),
    extraFields: (row.extra_payload_fields as Record<string, unknown>) ?? {},
    fieldSelection: (row.field_selection as string[] | null) ?? null,
  };
}

/** The configured custom-header NAMES only (never the values) — for echoing back to the edit form. */
export async function getAlertWebhookHeaderNames(workspaceId: string): Promise<string[]> {
  const cfg = await getAlertWebhook(workspaceId);
  return cfg ? Object.keys(cfg.headers) : [];
}

/** Create or update a workspace's alert webhook (singleton per workspace). Encrypts header values. */
export async function upsertAlertWebhook(workspaceId: string, input: AlertWebhookInput): Promise<void> {
  const values = {
    enabled: input.enabled ?? true,
    url: input.url,
    custom_headers_encrypted: encryptHeaderMap(input.headers),
    extra_payload_fields: input.extraFields ?? {},
    field_selection: input.fieldSelection ?? null,
  };
  await db
    .insert(alertWebhooks)
    .values({ workspace_id: workspaceId, ...values })
    .onConflictDoUpdate({ target: alertWebhooks.workspace_id, set: values });
}

/** Remove a workspace's alert webhook config. */
export async function deleteAlertWebhook(workspaceId: string): Promise<void> {
  await db.delete(alertWebhooks).where(eq(alertWebhooks.workspace_id, workspaceId));
}
