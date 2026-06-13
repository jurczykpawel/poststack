// Persistence for the instance-global license singleton: the token source
// (DB > env precedence), the derived state, and the JWKS snapshot. Orchestration
// (fetch JWKS -> verify -> derive -> persist) lives in gate.ts.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { instanceLicense } from "@/db/schema";
import { encryptString, decryptString } from "@/lib/crypto";
import { env } from "@/lib/env";
import { parseJwksJson } from "@/lib/license/jwks";
import type { JwksKey } from "@/lib/license/format";

const SINGLETON = "singleton";

export type LicenseStatus = "none" | "active" | "expired" | "invalid";

export interface LicenseRow {
  status: LicenseStatus;
  tier: string | null;
  expiresAt: Date | null;
  verifiedAt: Date | null;
  lastError: string | null;
  hasToken: boolean;
}

async function selectRow() {
  return db.query.instanceLicense.findFirst({ where: eq(instanceLicense.id, SINGLETON) });
}

export async function readLicenseRow(): Promise<LicenseRow | null> {
  const row = await selectRow();
  if (!row) return null;
  return {
    status: row.status as LicenseStatus,
    tier: row.tier,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
    lastError: row.last_error,
    hasToken: !!row.token,
  };
}

/** The active token, DB (panel) taking precedence over env (bootstrap default). */
export async function resolveTokenSource(): Promise<{
  token: string | null;
  source: "db" | "env" | "none";
}> {
  const row = await selectRow();
  if (row?.token) return { token: decryptString(row.token), source: "db" };
  if (env.LICENSE_KEY) return { token: env.LICENSE_KEY, source: "env" };
  return { token: null, source: "none" };
}

export interface PersistInput {
  // undefined = leave the token column untouched; null = clear it; string = encrypt + store.
  token?: string | null;
  status: LicenseStatus;
  tier: string | null;
  expiresAt: Date | null;
  lastError: string | null;
}

export async function persistLicenseState(input: PersistInput): Promise<void> {
  const tokenCol = input.token === undefined ? undefined : input.token === null ? null : encryptString(input.token);
  const now = new Date();
  const base = {
    tier: input.tier,
    status: input.status,
    expires_at: input.expiresAt,
    verified_at: now,
    last_error: input.lastError,
    updated_at: now,
  };
  await db
    .insert(instanceLicense)
    .values({ id: SINGLETON, token: tokenCol ?? null, ...base })
    .onConflictDoUpdate({
      target: instanceLicense.id,
      set: tokenCol === undefined ? base : { ...base, token: tokenCol },
    });
}

/** Removes the panel-stored token, reverting to the env token (or free). */
export async function clearStoredToken(): Promise<void> {
  await db
    .insert(instanceLicense)
    .values({ id: SINGLETON, token: null, status: "none", tier: null, last_error: null })
    .onConflictDoUpdate({
      target: instanceLicense.id,
      set: { token: null, updated_at: new Date() },
    });
}

export async function readJwksSnapshot(): Promise<JwksKey[]> {
  const row = await selectRow();
  if (!row?.jwks_snapshot) return [];
  return parseJwksJson(JSON.stringify(row.jwks_snapshot));
}

export async function writeJwksSnapshot(keys: JwksKey[]): Promise<void> {
  await db
    .insert(instanceLicense)
    .values({ id: SINGLETON, jwks_snapshot: { keys } })
    .onConflictDoUpdate({
      target: instanceLicense.id,
      set: { jwks_snapshot: { keys } },
    });
}
