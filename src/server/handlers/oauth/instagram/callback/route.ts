import { and, eq, inArray } from "drizzle-orm";
import { authenticate } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/oauth/state";
import { upsertChannels } from "@/lib/channels/upsert";
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
    const provider = getProvider("instagram");
    const redirectUri = `${env.APP_URL}/api/oauth/instagram/callback`;
    const accounts = await provider.authenticate(code, redirectUri);

    if (accounts.length === 0) return redirect("/channels?error=no_ig_accounts");

    await upsertChannels(auth.workspaceId, "instagram", accounts);

    // Auto-subscribe underlying FB pages to webhook events (non-blocking). IG webhooks are delivered
    // through the Page subscription, so a failed subscribe means the IG channel silently receives no
    // inbound — flag those channels (by their IG-account platform_id) so it's visible.
    if (provider.subscribePageWebhooks) {
      const subscribable = accounts.filter((a) => a.tokens.page_id);
      const results = await Promise.allSettled(
        subscribable.map((a) => provider.subscribePageWebhooks!(String(a.tokens.page_id), a.tokens.access_token)),
      );
      const failedIds = subscribable
        .filter((_, i) => results[i].status === "rejected" || (results[i] as PromiseFulfilledResult<boolean>).value === false)
        .map((a) => a.platformId);
      if (failedIds.length > 0) {
        await db
          .update(channels)
          .set({ last_error: SUBSCRIBE_FAILED_ERROR })
          .where(and(eq(channels.workspace_id, auth.workspaceId), eq(channels.platform, "instagram"), inArray(channels.platform_id, failedIds)));
      }
    }

    return redirect(`/channels?connected=instagram&count=${accounts.length}`);
  } catch (e) {
    console.error("[oauth/instagram/callback]", e);
    return redirect("/channels?error=oauth_failed");
  }
}
