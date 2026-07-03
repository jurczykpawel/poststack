import { authenticate } from "@/lib/auth";
import { env } from "@/lib/env";
import { verifyOAuthState, clearOAuthStateCookie, clearPkceCookie } from "@/lib/oauth/state";
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

  // Verify CSRF state up front for a precise error (completePublishOAuth re-verifies defensively).
  try {
    verifyOAuthState(state, request.headers.get("cookie"));
  } catch {
    console.error(`[oauth-connect] ${platform} invalid_state (state present, cookie mismatch/absent)`);
    return redirect("/channels?error=invalid_state");
  }

  const auth = await authenticate(request).catch(() => null);
  if (!auth) return redirect("/login?redirect=/channels");

  try {
    const redirectUri = `${env.APP_URL}/api/oauth/connect/${platform}/callback`;
    const r = await completePublishOAuth({
      platform,
      code,
      state,
      cookieHeader: request.headers.get("cookie"),
      redirectUri,
      workspaceId: auth.workspaceId,
    });
    return redirect(`/channels?connected=${platform}&count=1`, r.clearCookies);
  } catch (err) {
    if (err instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error(`[oauth-connect] ${platform} connect failed:`, err instanceof Error ? err.message : err);
    return redirect("/channels?error=oauth_failed");
  }
}
