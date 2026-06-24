import { env } from "@/lib/env";
import type { TokenData } from "@/lib/platforms/base";

export interface GoogleApp { clientId: string; clientSecret: string }

export async function resolveGoogleApp(_workspaceId: string): Promise<GoogleApp> {
  // SEAM (RESELLER1): v1 instance-level env; later per-workspace creds.
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

export function buildGoogleAuthUrl(app: GoogleApp, redirectUri: string, state: string, scopes: string[]): string {
  const p = new URLSearchParams({
    client_id: app.clientId, redirect_uri: redirectUri, response_type: "code",
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    state, scope: scopes.join(" "),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function tokenRequest(body: URLSearchParams, fetchImpl = fetch): Promise<TokenData> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`google token error: ${j.error ?? res.status}`);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
  };
}

export function exchangeGoogleCode(code: string, redirectUri: string, app: GoogleApp, fetchImpl = fetch): Promise<TokenData> {
  return tokenRequest(new URLSearchParams({
    code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret,
    grant_type: "authorization_code",
  }), fetchImpl);
}

export function refreshGoogleToken(refreshToken: string, app: GoogleApp, fetchImpl = fetch): Promise<TokenData> {
  return tokenRequest(new URLSearchParams({
    refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret,
    grant_type: "refresh_token",
  }), fetchImpl);
}
