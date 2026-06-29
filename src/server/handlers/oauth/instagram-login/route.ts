import { authenticate } from "@/lib/auth";
import { generateOAuthState } from "@/lib/oauth/state";
import { env } from "@/lib/env";
import { ApiErrors } from "@/lib/api/response";
import { getConfig } from "@/lib/settings/config";
import { buildInstagramLoginAuthUrl } from "@/lib/platforms/instagram-login";

export const runtime = "nodejs";

// Start the Instagram Business Login flow (IGML5). Distinct from /api/oauth/instagram (the
// Facebook-Login-derived IG flow) — this one mints the IGQW messaging token used to receive/reply to
// IG DMs at Standard Access. The callback augments the existing IG channel with that token.
export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  // Guard: if IG-Login isn't configured (self-hoster hasn't set the app credentials), don't proceed
  // into a broken OAuth (empty client_id → inbound webhooks 403). getConfig returns "" when unset.
  const [appId, appSecret] = await Promise.all([getConfig("INSTAGRAM_APP_ID"), getConfig("INSTAGRAM_APP_SECRET")]);
  if (!appId || !appSecret) {
    return new Response(null, { status: 302, headers: { Location: "/channels?error=instagram_login_not_configured" } });
  }

  const { state, setCookie } = generateOAuthState();
  const redirectUri = `${env.APP_URL}/api/oauth/instagram-login/callback`;
  const url = await buildInstagramLoginAuthUrl(state, redirectUri);

  return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": setCookie } });
}
