import { authenticateSession, type SessionAuthContext } from "@/lib/auth";
import {
  verifyOAuthState,
  verifyOAuthStateCookie,
  type OAuthFlow,
  type OAuthPurpose,
} from "./state";

export type OAuthCallbackAuth =
  | { ok: true; auth: SessionAuthContext; purpose: OAuthPurpose }
  | { ok: false; reason: OAuthCallbackFailure };
type OAuthCallbackFailure = "invalid_state" | "oauth_expired" | "session_required";

export function oauthCallbackFailurePath(reason: OAuthCallbackFailure): string {
  return reason === "session_required" ? "/login?redirect=/channels" : `/channels?error=${reason}`;
}

const stateFailure = (error: unknown): OAuthCallbackFailure => ((error as Error)?.name === "OAuthStateExpiredError" ? "oauth_expired" : "invalid_state");

/** Apply the shared authentication boundary for an interactive OAuth callback. */
export async function authenticateOAuthCallback(
  request: Request,
  state: string,
  flow: OAuthFlow,
): Promise<OAuthCallbackAuth> {
  const cookieHeader = request.headers.get("cookie");
  try {
    verifyOAuthStateCookie(state, cookieHeader);
  } catch (error) {
    return { ok: false, reason: stateFailure(error) };
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
  } catch (error) {
    return { ok: false, reason: stateFailure(error) };
  }

  return { ok: true, auth, purpose };
}
