/**
 * Built-in OAuth 2.1 authorization server for `/mcp` (authorization code + PKCE S256, refresh-token
 * rotation, revocation; clients via dynamic registration or a Client ID Metadata Document).
 *
 * An access token is an ordinary API key row (`api_keys`, `oauth_grant_id` set, short expiry), so
 * `/mcp` and `/api/v1` authorize it exactly like a `sk_live_` key: same workspace, scopes and limits.
 * Deleting the grant deletes its tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiKeys, oauthClients, oauthGrants, workspaceMembers, workspaces } from "@/db/schema";
import { env } from "@/lib/env";
import { generateApiKey } from "@/lib/auth";
import { API_SCOPE_PRESETS, API_SCOPES, isInstanceScope } from "@/lib/auth/scopes";
import { safeFetch } from "@/lib/net/safe-fetch";

export const ACCESS_TOKEN_TTL_S = 3600;
const CODE_TTL_MS = 2 * 60_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const UNUSED_CLIENT_TTL_MS = 30 * 86_400_000;
const METADATA_CACHE_MS = 5 * 60_000;

export const issuer = (): string => env.APP_URL.replace(/\/+$/, "");
export const mcpResource = (): string => `${issuer()}/mcp`;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const newSecret = (): string => randomBytes(32).toString("base64url");

/** What the consent screen offers. Operator-only `instance_*` scopes are never granted over OAuth. */
export const OAUTH_ACCESS = {
  read: API_SCOPE_PRESETS.find((p) => p.id === "read_only")!.scopes,
  write: API_SCOPES.filter((s) => !isInstanceScope(s)),
} as const;
export type OAuthAccess = keyof typeof OAUTH_ACCESS;

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const invalidGrant = () => new OAuthError("invalid_grant", "The code or refresh token is invalid, expired or already used.");

export interface OAuthClient { id: string; name: string; redirect_uris: string[] }

// ─── redirect URIs and PKCE ─────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const parseUrl = (raw: string): URL | null => { try { return new URL(raw); } catch { return null; } };
const isLoopback = (u: URL): boolean => u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);

/** https, or http on a loopback host (RFC 8252). No fragment, no credentials. */
export function isAllowedRedirectUri(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u || raw.includes("#") || u.username || u.password) return false;
  return u.protocol === "https:" || isLoopback(u);
}

/** Exact string match; only a loopback redirect may use a different port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const r = parseUrl(requested);
  if (!r || !isLoopback(r) || !isAllowedRedirectUri(requested)) return false;
  return registered.some((raw) => {
    const u = parseUrl(raw);
    return !!u && isLoopback(u) && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
  });
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** RFC 8707: a token may only be requested for this instance's MCP endpoint (or the instance itself). */
export const resourceAllowed = (resource: string | undefined): boolean =>
  resource === undefined || [mcpResource(), `${mcpResource()}/`, issuer(), `${issuer()}/`].includes(resource);

// ─── clients ────────────────────────────────────────────────────────────────

const clientMetadata = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string().max(2000).refine(isAllowedRedirectUri, "redirect_uris must be https or loopback http, without a fragment")).min(1).max(10),
});

/** RFC 7591 registration. The client is always public (`none`), whatever auth method it asked for. */
export async function registerClient(body: unknown): Promise<OAuthClient & { created_at: Date }> {
  const parsed = clientMetadata.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new OAuthError(field === "redirect_uris" ? "invalid_redirect_uri" : "invalid_client_metadata", parsed.error.issues[0]?.message ?? "Invalid client metadata");
  }
  // Registrations that never led to a connection are dropped after a while.
  await db.delete(oauthClients).where(and(
    lt(oauthClients.created_at, new Date(Date.now() - UNUSED_CLIENT_TTL_MS)),
    sql`NOT EXISTS (SELECT 1 FROM ${oauthGrants} WHERE ${oauthGrants.client_id} = ${oauthClients.id})`,
  ));
  const [client] = await db.insert(oauthClients).values({
    id: `mcp_${randomBytes(16).toString("hex")}`,
    name: parsed.data.client_name ?? "MCP client",
    redirect_uris: parsed.data.redirect_uris,
  }).returning();
  return client;
}

const metadataCache = new Map<string, { client: OAuthClient; until: number }>();

/** Client ID Metadata Document: the client_id is an https URL serving its own registration. */
async function fetchClientMetadata(clientId: string): Promise<OAuthClient | null> {
  const hit = metadataCache.get(clientId);
  if (hit && hit.until > Date.now()) return hit.client;
  const url = parseUrl(clientId);
  if (!url || url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username) return null;
  try {
    const res = await safeFetch(clientId, { headers: { accept: "application/json" } }, { allow: new Set(["public"]), deadlineMs: 5_000, maxResponseBytes: 16_384 });
    if (!res.ok) return null;
    const doc = (await res.json()) as { client_id?: unknown };
    const parsed = clientMetadata.safeParse(doc);
    if (!parsed.success || doc.client_id !== clientId) return null;
    const client = { id: clientId, name: parsed.data.client_name ?? url.host, redirect_uris: parsed.data.redirect_uris };
    if (metadataCache.size > 500) metadataCache.clear();
    metadataCache.set(clientId, { client, until: Date.now() + METADATA_CACHE_MS });
    return client;
  } catch {
    return null;
  }
}

export async function findClient(clientId: string | undefined): Promise<OAuthClient | null> {
  if (!clientId) return null;
  if (clientId.startsWith("https://")) return fetchClientMetadata(clientId);
  return (await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId), columns: { id: true, name: true, redirect_uris: true } })) ?? null;
}

// ─── authorization request ──────────────────────────────────────────────────

export const AUTHORIZE_PARAMS = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "scope", "resource"] as const;
export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>;
export interface AuthorizeRequest { client: OAuthClient; redirectUri: string; state?: string; codeChallenge: string; requestedScopes: string[]; params: AuthorizeParams }

/** RFC 6749 §4.1.2 response, plus `iss` (RFC 9207) on success and error alike. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set("iss", issuer());
  return u.toString();
}

/**
 * Validates an authorization request. Until client and redirect_uri are trusted, errors are shown to
 * the user (`fatal`) and never redirected; after that they go back to the client (`redirect`).
 */
export async function parseAuthorizeRequest(params: AuthorizeParams): Promise<{ ok: AuthorizeRequest } | { fatal: string } | { redirect: string }> {
  const client = await findClient(params.client_id);
  if (!client) return { fatal: "This app is not registered with this server." };
  const redirectUri = params.redirect_uri;
  if (!redirectUri || !redirectUriMatches(client.redirect_uris, redirectUri)) return { fatal: "The app sent a return address it did not register." };
  const fail = (error: string, description: string) => ({ redirect: redirectWith(redirectUri, { error, error_description: description, state: params.state }) });
  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")) return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  if (!resourceAllowed(params.resource)) return fail("invalid_target", `Tokens are only issued for ${mcpResource()}.`);
  const requestedScopes = (params.scope ?? "").split(" ").filter((s) => (API_SCOPES as readonly string[]).includes(s));
  return { ok: { client, redirectUri, state: params.state, codeChallenge: params.code_challenge!, requestedScopes, params } };
}

/** Scopes for the chosen access level, narrowed to what the client asked for (if it asked). */
export function grantScopes(access: OAuthAccess, requested: readonly string[]): string[] {
  const offered: readonly string[] = OAUTH_ACCESS[access];
  return requested.length ? offered.filter((s) => requested.includes(s)) : [...offered];
}

export function memberWorkspaces(userId: string) {
  return db.select({ id: workspaces.id, name: workspaces.name }).from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspace_id))
    .where(eq(workspaceMembers.user_id, userId)).orderBy(workspaceMembers.created_at);
}

/** Records the approval and returns the one-time code. A metadata-document client is stored here. */
export async function createAuthorizationCode(req: AuthorizeRequest, userId: string, workspaceId: string, scopes: string[]): Promise<string> {
  const code = newSecret();
  const { id, name, redirect_uris } = req.client;
  await db.transaction(async (tx) => {
    await tx.insert(oauthClients).values({ id, name, redirect_uris }).onConflictDoUpdate({ target: oauthClients.id, set: { name, redirect_uris } });
    await tx.delete(oauthGrants).where(and(eq(oauthGrants.status, "pending"), lt(oauthGrants.code_expires_at, new Date())));
    await tx.insert(oauthGrants).values({
      client_id: id, workspace_id: workspaceId, user_id: userId, scopes, code_hash: sha256(code),
      code_challenge: req.codeChallenge, redirect_uri: req.redirectUri, code_expires_at: new Date(Date.now() + CODE_TTL_MS),
    });
  });
  return code;
}

// ─── token endpoint ─────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface TokenResponse { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }

async function issueTokens(tx: Tx, grant: { id: string; workspace_id: string; user_id: string }, scopes: string[], refreshToken: string): Promise<TokenResponse> {
  await tx.delete(apiKeys).where(eq(apiKeys.oauth_grant_id, grant.id));
  const { plaintext, prefix, hash } = generateApiKey();
  const now = Date.now();
  await tx.insert(apiKeys).values({
    workspace_id: grant.workspace_id, name: "OAuth access token", key_hash: hash, key_prefix: prefix, scopes,
    created_by_user_id: grant.user_id, oauth_grant_id: grant.id, last_used_at: new Date(now), expires_at: new Date(now + ACCESS_TOKEN_TTL_S * 1000),
  });
  return { access_token: plaintext, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refreshToken, scope: scopes.join(" ") };
}

export async function exchangeCode(p: { code?: string; code_verifier?: string; redirect_uri?: string; client_id?: string; resource?: string }): Promise<TokenResponse> {
  if (!resourceAllowed(p.resource)) throw new OAuthError("invalid_target", `Tokens are only issued for ${mcpResource()}.`);
  if (!p.code || !p.code_verifier || !p.client_id) throw new OAuthError("invalid_request", "code, code_verifier and client_id are required.");
  const grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.code_hash, sha256(p.code)) });
  if (!grant) throw invalidGrant();
  const valid = grant.status === "pending" && grant.code_expires_at > new Date() && grant.client_id === p.client_id
    && grant.redirect_uri === p.redirect_uri && pkceMatches(p.code_verifier, grant.code_challenge);
  // A code works once: any failed or repeated use also ends the connection it created.
  if (!valid) { await db.delete(oauthGrants).where(eq(oauthGrants.id, grant.id)); throw invalidGrant(); }
  const refreshToken = newSecret();
  return db.transaction(async (tx) => {
    const [active] = await tx.update(oauthGrants)
      .set({ status: "active", refresh_token_hash: sha256(refreshToken), refresh_expires_at: new Date(Date.now() + REFRESH_TTL_MS) })
      .where(and(eq(oauthGrants.id, grant.id), eq(oauthGrants.status, "pending"))).returning();
    if (!active) throw invalidGrant();
    return issueTokens(tx, active, active.scopes, refreshToken);
  });
}

/** Rotates the refresh token. `scope` may narrow the new access token, never widen it. */
export async function refreshTokens(p: { refresh_token?: string; client_id?: string; scope?: string; resource?: string }): Promise<TokenResponse> {
  if (!resourceAllowed(p.resource)) throw new OAuthError("invalid_target", `Tokens are only issued for ${mcpResource()}.`);
  if (!p.refresh_token || !p.client_id) throw new OAuthError("invalid_request", "refresh_token and client_id are required.");
  const oldHash = sha256(p.refresh_token);
  const refreshToken = newSecret();
  const result = await db.transaction(async (tx) => {
    const [grant] = await tx.update(oauthGrants)
      .set({ refresh_token_hash: sha256(refreshToken), refresh_expires_at: new Date(Date.now() + REFRESH_TTL_MS) })
      .where(and(eq(oauthGrants.refresh_token_hash, oldHash), eq(oauthGrants.client_id, p.client_id!), eq(oauthGrants.status, "active"), gt(oauthGrants.refresh_expires_at, new Date())))
      .returning();
    if (!grant) throw invalidGrant();
    const member = await tx.query.workspaceMembers.findFirst({ where: and(eq(workspaceMembers.user_id, grant.user_id), eq(workspaceMembers.workspace_id, grant.workspace_id)), columns: { user_id: true } });
    if (!member) { await tx.delete(oauthGrants).where(eq(oauthGrants.id, grant.id)); return null; }
    const scopes = p.scope === undefined ? grant.scopes : p.scope.split(" ").filter(Boolean);
    if (!scopes.length || scopes.some((s) => !grant.scopes.includes(s))) throw new OAuthError("invalid_scope", "scope must be a subset of the approved scopes.");
    return issueTokens(tx, grant, scopes, refreshToken);
  });
  if (!result) throw invalidGrant();
  return result;
}

/** RFC 7009. Revoking either token ends the whole connection. Unknown tokens are not an error. */
export async function revokeToken(token: string): Promise<void> {
  const hash = sha256(token);
  const byAccessToken = db.select({ id: apiKeys.oauth_grant_id }).from(apiKeys).where(eq(apiKeys.key_hash, hash));
  await db.delete(oauthGrants).where(or(eq(oauthGrants.refresh_token_hash, hash), inArray(oauthGrants.id, byAccessToken)));
}

// ─── connected apps (Settings) ──────────────────────────────────────────────

export function listConnectedApps(workspaceId: string) {
  return db.select({
    id: oauthGrants.id, client_id: oauthGrants.client_id, client_name: oauthClients.name, redirect_uri: oauthGrants.redirect_uri,
    scopes: oauthGrants.scopes, created_at: oauthGrants.created_at,
    last_used_at: sql<Date | null>`max(${apiKeys.last_used_at})`.mapWith(apiKeys.last_used_at),
  }).from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.client_id))
    .leftJoin(apiKeys, eq(apiKeys.oauth_grant_id, oauthGrants.id))
    .where(and(eq(oauthGrants.workspace_id, workspaceId), eq(oauthGrants.status, "active")))
    .groupBy(oauthGrants.id, oauthClients.name).orderBy(desc(oauthGrants.created_at));
}

export async function disconnectApp(workspaceId: string, grantId: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(grantId).success) return false;
  const res = await db.delete(oauthGrants).where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.workspace_id, workspaceId)));
  return (res.rowCount ?? 0) > 0;
}
