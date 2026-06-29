import { authenticate } from "@/lib/auth";
import { generateOAuthState } from "@/lib/oauth/state";
import { env } from "@/lib/env";
import { ApiErrors } from "@/lib/api/response";
import { buildInstagramLoginAuthUrl } from "@/lib/platforms/instagram-login";

export const runtime = "nodejs";

// Start the Instagram Business Login flow (IGML5). Distinct from /api/oauth/instagram (the
// Facebook-Login-derived IG flow) — this one mints the IGQW messaging token used to receive/reply to
// IG DMs at Standard Access. The callback augments the existing IG channel with that token.
export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { state, setCookie } = generateOAuthState();
  const redirectUri = `${env.APP_URL}/api/oauth/instagram-login/callback`;
  const url = await buildInstagramLoginAuthUrl(state, redirectUri);

  return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": setCookie } });
}
