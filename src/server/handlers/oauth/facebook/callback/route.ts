import { authenticate } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/oauth/state";
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

  try {
    verifyOAuthState(state, request.headers.get("cookie"));
  } catch {
    return redirect("/channels?error=invalid_state");
  }

  const auth = await authenticate(request).catch(() => null);
  if (!auth) return redirect("/login?redirect=/channels");

  try {
    const provider = getProvider("facebook");
    const redirectUri = `${env.APP_URL}/api/oauth/facebook/callback`;
    const accounts = await provider.authenticate(code, redirectUri);

    if (accounts.length === 0) return redirect("/channels?error=no_pages");

    await assertChannelsAllowed(auth.workspaceId, "facebook", accounts);
    await upsertChannels(auth.workspaceId, "facebook", accounts);
    // Auto-subscribe to inbound webhook events (best-effort; flags any that fail). Same path as IG +
    // the managed-connection mint, so a connected account both publishes AND receives on one row.
    await subscribeChannelWebhooks(auth.workspaceId, "facebook", accounts);

    return redirect(`/channels?connected=facebook&count=${accounts.length}`);
  } catch (e) {
    if (e instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error("[oauth/facebook/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
