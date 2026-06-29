import { authenticate } from "@/lib/auth";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/oauth/state";
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

  if (error) return redirect("/channels?error=access_denied");
  if (!code || !state) return redirect("/channels?error=missing_params");

  try {
    verifyOAuthState(state, request.headers.get("cookie"));
  } catch {
    return redirect("/channels?error=invalid_state");
  }

  const auth = await authenticate(request).catch(() => null);
  if (!auth) return redirect("/login?redirect=/channels");

  try {
    const redirectUri = `${env.APP_URL}/api/oauth/instagram-login/callback`;
    const { igUserId, username, messagingToken, expiresAt } = await exchangeInstagramLoginCode(code, redirectUri);

    // The IG business account id is the channel platform_id. The token blob here is a placeholder —
    // the real write is the augment path, which preserves any existing FB page token.
    const accounts = [
      { platformId: igUserId, displayName: username ?? igUserId, username, tokens: { access_token: "" } },
    ];

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
    if (e instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error("[oauth/instagram-login/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
