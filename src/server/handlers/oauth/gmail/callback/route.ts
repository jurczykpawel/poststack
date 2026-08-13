import { getProvider } from "@/lib/platforms/registry";
import { clearOAuthStateCookie, OAUTH_FLOWS } from "@/lib/oauth/state";
import { authenticateOAuthCallback, oauthCallbackFailurePath } from "@/lib/oauth/callback";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
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

  const callbackAuth = await authenticateOAuthCallback(request, state, OAUTH_FLOWS.gmail);
  if (!callbackAuth.ok) {
    return redirect(oauthCallbackFailurePath(callbackAuth.reason));
  }
  const { auth } = callbackAuth;

  try {
    const provider = getProvider("gmail");
    const redirectUri = `${env.APP_URL}/api/oauth/gmail/callback`;
    const accounts = await provider.authenticate(code, redirectUri);

    if (accounts.length === 0) return redirect("/channels?error=no_gmail_accounts");

    await assertChannelsAllowed(auth.workspaceId, "gmail", accounts);
    await upsertChannels(auth.workspaceId, "gmail", accounts);

    return redirect(`/channels?connected=gmail&count=${accounts.length}`);
  } catch (e) {
    if (e instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error("[oauth/gmail/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
