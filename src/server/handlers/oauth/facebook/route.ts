import { authenticate } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { generateOAuthState } from "@/lib/oauth/state";
import { env } from "@/lib/env";
import { ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { state, setCookie } = generateOAuthState();
  const provider = getProvider("facebook");
  const redirectUri = `${env.APP_URL}/api/oauth/facebook/callback`;
  const url = await provider.generateAuthUrl(state, redirectUri);

  return new Response(null, { status: 302, headers: { Location: url, "Set-Cookie": setCookie } });
}
