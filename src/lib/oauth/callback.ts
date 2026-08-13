import { authenticateSession, type SessionAuthContext } from "@/lib/auth";
import {
  verifyOAuthState,
  verifyOAuthStateCookie,
  type OAuthFlow,
} from "./state";

export type OAuthCallbackAuth =
  | { ok: true; auth: SessionAuthContext }
  | { ok: false; reason: "invalid_state" | "session_required" };

export function oauthCallbackFailurePath(reason: "invalid_state" | "session_required"): string {
  return reason === "invalid_state"
    ? "/channels?error=invalid_state"
    : "/login?redirect=/channels";
}

/** Apply the shared authentication boundary for an interactive OAuth callback. */
export async function authenticateOAuthCallback(
  request: Request,
  state: string,
  flow: OAuthFlow,
): Promise<OAuthCallbackAuth> {
  const cookieHeader = request.headers.get("cookie");
  try {
    verifyOAuthStateCookie(state, cookieHeader);
  } catch {
    return { ok: false, reason: "invalid_state" };
  }

  const auth = await authenticateSession(request).catch(() => null);
  if (!auth) return { ok: false, reason: "session_required" };

  try {
    verifyOAuthState(state, cookieHeader, auth, flow);
  } catch {
    return { ok: false, reason: "invalid_state" };
  }

  return { ok: true, auth };
}
