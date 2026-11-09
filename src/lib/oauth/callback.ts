import { authenticateSession, type SessionAuthContext } from "@/lib/auth";
import {
  verifyOAuthState,
  verifyOAuthStateCookie,
  type OAuthFlow,
  type OAuthPurpose,
} from "./state";

export type OAuthCallbackAuth =
  | { ok: true; auth: SessionAuthContext; purpose: OAuthPurpose }
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

  let purpose: OAuthPurpose;
  try {
    purpose = verifyOAuthState(state, cookieHeader, auth, flow) ?? { kind: "connect" };
    if (purpose.kind === "insights") {
      const { consumeInsightConsent } = await import("@/lib/insights/consent");
      await consumeInsightConsent({ workspaceId: auth.workspaceId, channelId: purpose.channelId }, auth, state, purpose.transport);
    }
  } catch {
    return { ok: false, reason: "invalid_state" };
  }

  return { ok: true, auth, purpose };
}
