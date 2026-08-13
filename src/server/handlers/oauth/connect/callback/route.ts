import { env } from "@/lib/env";
import { clearOAuthStateCookie, clearPkceCookie, connectOAuthFlow } from "@/lib/oauth/state";
import { authenticateOAuthCallback, oauthCallbackFailurePath } from "@/lib/oauth/callback";
import { completePublishOAuth } from "@/lib/oauth/connect";
import { ProRequiredError } from "@/lib/license/gate";

export const runtime = "nodejs";

function redirect(path: string, clearCookies: string[] = [clearOAuthStateCookie(), clearPkceCookie()]): Response {
  const headers = new Headers({ Location: `${env.APP_URL}${path}` });
  for (const c of clearCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

// GET /api/oauth/connect/:platform/callback — verify state, exchange the code, connect the channel.
export async function GET(request: Request, platform: string): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Observability: the provider round-trip is otherwise a black box — log the callback shape (never the
  // code value) so a failed connect is diagnosable instead of a silent "?error=" redirect.
  const qkeys = [...searchParams.keys()].join(",");
  if (error) {
    console.error(`[oauth-connect] ${platform} callback returned error=${error} desc=${searchParams.get("error_description") ?? "-"} keys=${qkeys}`);
    return redirect("/channels?error=access_denied");
  }
  if (!code || !state) {
    console.error(`[oauth-connect] ${platform} callback missing params (code=${!!code} state=${!!state}) keys=${qkeys}`);
    return redirect("/channels?error=missing_params");
  }

  const callbackAuth = await authenticateOAuthCallback(request, state, connectOAuthFlow(platform));
  if (!callbackAuth.ok) {
    if (callbackAuth.reason === "invalid_state") {
      console.error(`[oauth-connect] ${platform} invalid_state`);
    }
    return redirect(oauthCallbackFailurePath(callbackAuth.reason));
  }
  const { auth } = callbackAuth;

  try {
    const redirectUri = `${env.APP_URL}/api/oauth/connect/${platform}/callback`;
    const r = await completePublishOAuth({
      platform,
      code,
      state,
      cookieHeader: request.headers.get("cookie"),
      redirectUri,
      auth,
    });
    return redirect(`/channels?connected=${platform}&count=1`, r.clearCookies);
  } catch (err) {
    if (err instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error(`[oauth-connect] ${platform} connect failed:`, err instanceof Error ? err.message : err);
    return redirect("/channels?error=oauth_failed");
  }
}
