import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { generateOAuthState } from "@/lib/oauth/state";
import { env } from "@/lib/env";
import { ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const state = await generateOAuthState();
  const provider = getProvider("instagram");
  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/oauth/instagram/callback`;
  const url = provider.generateAuthUrl(state, redirectUri);

  return NextResponse.redirect(url);
}
