import { getProvider } from "@/lib/platforms/registry";
import { clearOAuthStateCookie, OAUTH_FLOWS } from "@/lib/oauth/state";
import { authenticateOAuthCallback, oauthCallbackFailurePath } from "@/lib/oauth/callback";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { subscribeChannelWebhooks } from "@/lib/channels/subscribe";
import { ProRequiredError } from "@/lib/license/gate";
import { env } from "@/lib/env";

export const runtime = "nodejs";

function redirect(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${env.APP_URL}${path}`, "Set-Cookie": clearOAuthStateCookie() },
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) return redirect("/channels?error=access_denied");
  if (!code || !state) return redirect("/channels?error=missing_params");

  const callbackAuth = await authenticateOAuthCallback(request, state, OAUTH_FLOWS.instagram);
  if (!callbackAuth.ok) {
    return redirect(oauthCallbackFailurePath(callbackAuth.reason));
  }
  const { auth } = callbackAuth;

  try {
    const provider = getProvider("instagram");
    const redirectUri = `${env.APP_URL}/api/oauth/instagram/callback`;
    const accounts = await provider.authenticate(code, redirectUri);

    if (accounts.length === 0) return redirect("/channels?error=no_ig_accounts");

    await assertChannelsAllowed(auth.workspaceId, "instagram", accounts);
    await upsertChannels(auth.workspaceId, "instagram", accounts);
    // Auto-subscribe to inbound webhook events (IG events ride the linked Page subscription). Same
    // path as FB + the managed-connection mint, so the account both publishes AND receives on one row.
    await subscribeChannelWebhooks(auth.workspaceId, "instagram", accounts);

    return redirect(`/channels?connected=instagram&count=${accounts.length}`);
  } catch (e) {
    if (e instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error("[oauth/instagram/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
