import { declineInsightConsent, finishInsightConsent, insightConsentPath } from "@/lib/insights/consent";
import { clearOAuthStateCookie, OAUTH_FLOWS } from "@/lib/oauth/state";
import { authenticateOAuthCallback, oauthCallbackFailurePath } from "@/lib/oauth/callback";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { subscribeInstagramMessaging } from "@/lib/channels/subscribe";
import { ProRequiredError } from "@/lib/license/gate";
import { env } from "@/lib/env";
import { exchangeInstagramLoginCode } from "@/lib/platforms/instagram-login";

export const runtime = "nodejs";

function redirect(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${env.APP_URL}${path}`, "Set-Cookie": clearOAuthStateCookie() },
  });
}

// Instagram Business Login callback (IGML5): exchange the code for the long-lived IGQW messaging
// token and AUGMENT the IG channel for this account with it — without touching the FB page token
// (publishing/comments keep working). If no channel exists yet, a minimal IG-Login-only one is made.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (!state) return redirect("/channels?error=missing_params");

  const callbackAuth = await authenticateOAuthCallback(request, state, OAUTH_FLOWS.instagramLogin);
  if (!callbackAuth.ok) {
    return redirect(oauthCallbackFailurePath(callbackAuth.reason));
  }
  const { auth, purpose } = callbackAuth;
  const ref = purpose.kind === "insights" ? { workspaceId: auth.workspaceId, channelId: purpose.channelId } : null;
  const consentPath = ref ? insightConsentPath(ref.channelId) : null;
  if (error || !code) {
    if (ref) {
      await declineInsightConsent(ref, auth, state).catch(() => {});
      return redirect(consentPath!);
    }
    return redirect(error ? "/channels?error=access_denied" : "/channels?error=missing_params");
  }

  try {
    const redirectUri = `${env.APP_URL}/api/oauth/instagram-login/callback`;
    const { igUserId, username, messagingToken, expiresAt } = await exchangeInstagramLoginCode(code, redirectUri);

    // The IG business account id is the channel platform_id. The token blob here is a placeholder —
    // the real write is the augment path, which preserves any existing FB page token.
    const accounts = [
      { platformId: igUserId, displayName: username ?? igUserId, username, tokens: { access_token: "" } },
    ];

    if (ref) {
      await finishInsightConsent(ref, auth, [{ ...accounts[0], tokens: {
        access_token: "", messaging_token: messagingToken, messaging_token_expires_at: Math.floor(expiresAt.getTime() / 1000),
      } }], state);
      return redirect(consentPath!);
    }

    await assertChannelsAllowed(auth.workspaceId, "instagram", accounts);
    await upsertChannels(auth.workspaceId, "instagram", accounts, {
      augmentMessagingToken: { token: messagingToken, expiresAt },
    });

    // IGFU2/IGFU3: an IG-Login-only channel has no Facebook Page subscription, so it must subscribe
    // to messaging webhooks the IG-Login-native way (per-account) to receive DMs. The call also sets
    // the channel's status truthfully — needs_reauth (not a misleading "active") if it fails. Safe to
    // run for the augment-an-existing-FB-channel case too (idempotent, per-account subscription).
    await subscribeInstagramMessaging(auth.workspaceId, igUserId, messagingToken);

    return redirect(`/channels?connected=instagram_messaging`);
  } catch (e) {
    if (ref) {
      await declineInsightConsent(ref, auth, state).catch(() => {});
      return redirect(consentPath!);
    }
    if (e instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error("[oauth/instagram-login/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
