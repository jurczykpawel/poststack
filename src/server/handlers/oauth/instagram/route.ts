import { authenticateSession } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { generateOAuthState, OAUTH_FLOWS } from "@/lib/oauth/state";
import { env } from "@/lib/env";
import { ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await authenticateSession(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { state, setCookie } = generateOAuthState(auth, OAUTH_FLOWS.instagram);
  const provider = getProvider("instagram");
  const redirectUri = `${env.APP_URL}/api/oauth/instagram/callback`;
  const url = await provider.generateAuthUrl(state, redirectUri);

  return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": setCookie } });
}
