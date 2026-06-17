import { authenticate } from "@/lib/auth";
import { generateOAuthState } from "@/lib/oauth/state";
import { env } from "@/lib/env";
import { getConfig } from "@/lib/settings/config";
import { ApiErrors } from "@/lib/api/response";
import { googleAuthUrl } from "@/lib/youtube/client";

export const runtime = "nodejs";

// GET /api/oauth/youtube — start the Google consent flow to connect a YouTube channel.
export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const clientId = await getConfig("GOOGLE_CLIENT_ID");
  if (!clientId) {
    return ApiErrors.badRequest("YouTube isn't configured on this instance (GOOGLE_CLIENT_ID is unset)");
  }
  const { state, setCookie } = generateOAuthState();
  const redirectUri = `${env.APP_URL}/api/oauth/youtube/callback`;
  const url = googleAuthUrl({ clientId, redirectUri, state });
  return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": setCookie } });
}
