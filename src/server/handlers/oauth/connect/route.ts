import { authenticateSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { ApiErrors } from "@/lib/api/response";
import { startPublishOAuth } from "@/lib/oauth/connect";

export const runtime = "nodejs";

// GET /api/oauth/connect/:platform — start the generic publish-provider OAuth flow (TikTok, X,
// LinkedIn, Threads). Meta + YouTube keep their dedicated routes. One handler for every provider
// that exposes an oauthConfig(); the per-platform quirks live in the provider, not here.
// `?pages=1` starts the "connect pages" variant (e.g. LinkedIn Company Pages → picker).
export async function GET(request: Request, platform: string): Promise<Response> {
  const auth = await authenticateSession(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  try {
    const redirectUri = `${env.APP_URL}/api/oauth/connect/${platform}/callback`;
    const subAccounts = new URL(request.url).searchParams.get("pages") === "1";
    const { url, cookies } = await startPublishOAuth(platform, redirectUri, auth, { subAccounts });
    const headers = new Headers({ Location: url });
    for (const c of cookies) headers.append("Set-Cookie", c);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return ApiErrors.badRequest((e as Error).message);
  }
}
