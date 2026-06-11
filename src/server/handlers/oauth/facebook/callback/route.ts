import { and, eq, inArray } from "drizzle-orm";
import { authenticate } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/oauth/state";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { ProRequiredError } from "@/lib/license/gate";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { env } from "@/lib/env";

const SUBSCRIBE_FAILED_ERROR = "Webhook subscription failed — no inbound events until re-subscribed";

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

    // Auto-subscribe pages to webhook events (non-blocking, best-effort). A failed subscribe leaves
    // an active channel that silently receives NO inbound, so flag those channels' last_error to make
    // the half-connected state visible instead of invisible.
    if (provider.subscribePageWebhooks) {
      const results = await Promise.allSettled(
        accounts.map((a) => provider.subscribePageWebhooks!(a.platformId, a.tokens.access_token)),
      );
      const failedIds = accounts
        .filter((_, i) => results[i].status === "rejected" || (results[i] as PromiseFulfilledResult<boolean>).value === false)
        .map((a) => a.platformId);
      if (failedIds.length > 0) {
        await db
          .update(channels)
          .set({ last_error: SUBSCRIBE_FAILED_ERROR })
          .where(and(eq(channels.workspace_id, auth.workspaceId), eq(channels.platform, "facebook"), inArray(channels.platform_id, failedIds)));
      }
    }

    return redirect(`/channels?connected=facebook&count=${accounts.length}`);
  } catch (e) {
    if (e instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    console.error("[oauth/facebook/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
