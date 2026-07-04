import { authenticate } from "@/lib/auth";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/oauth/state";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { softDeleteReauthOrphans } from "@/lib/oauth/connect";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ProRequiredError } from "@/lib/license/gate";
import { env } from "@/lib/env";
import { getConfig } from "@/lib/settings/config";
import { exchangeGoogleCode, getMyChannel } from "@/lib/youtube/client";

export const runtime = "nodejs";

function redirect(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${env.APP_URL}${path}`, "Set-Cookie": clearOAuthStateCookie() },
  });
}

// GET /api/oauth/youtube/callback — exchange the code, resolve the channel, connect it.
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
    const redirectUri = `${env.APP_URL}/api/oauth/youtube/callback`;
    const { accessToken, refreshToken, expiresAt } = await exchangeGoogleCode({
      code,
      clientId: await getConfig("GOOGLE_CLIENT_ID"),
      clientSecret: await getConfig("GOOGLE_CLIENT_SECRET"),
      redirectUri,
    });
    // Without a refresh token we can't keep polling past the ~1h access-token life — force a re-consent.
    if (!refreshToken) return redirect("/channels?error=yt_no_refresh");

    const ch = await getMyChannel({ accessToken });
    if (!ch) return redirect("/channels?error=yt_no_channel");

    const account = {
      platformId: ch.id,
      displayName: ch.title,
      profilePicture: ch.thumbnail ?? undefined,
      tokens: { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt },
    };
    await assertChannelsAllowed(auth.workspaceId, "youtube", [account]);
    await upsertChannels(auth.workspaceId, "youtube", [account]);
    // Sweep any pre-migration @handle-keyed orphan for this same channel (SEEDCH1 self-cleanup).
    const newCh = await db.query.channels.findFirst({
      where: and(eq(channels.workspace_id, auth.workspaceId), eq(channels.platform, "youtube"), eq(channels.platform_id, ch.id)),
      columns: { id: true },
    });
    if (newCh) await softDeleteReauthOrphans(auth.workspaceId, "youtube", ch.handle ?? undefined, newCh.id);
    return redirect("/channels?connected=youtube&count=1");
  } catch (err) {
    if (err instanceof ProRequiredError) return redirect("/channels?error=pro_required");
    return redirect("/channels?error=oauth_failed");
  }
}
