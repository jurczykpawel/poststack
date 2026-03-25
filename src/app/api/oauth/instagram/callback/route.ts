import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { verifyOAuthState } from "@/lib/oauth/state";
import { upsertChannels } from "@/lib/channels/upsert";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?error=access_denied`
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?error=missing_params`
    );
  }

  try {
    await verifyOAuthState(state);
  } catch {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?error=invalid_state`
    );
  }

  const auth = await authenticate(request).catch(() => null);
  if (!auth) {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?redirect=/channels`
    );
  }

  try {
    const provider = getProvider("instagram");
    const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/oauth/instagram/callback`;
    const accounts = await provider.authenticate(code, redirectUri);

    if (accounts.length === 0) {
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/channels?error=no_ig_accounts`
      );
    }

    await upsertChannels(auth.workspaceId, "instagram", accounts);

    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?connected=instagram&count=${accounts.length}`
    );
  } catch (e) {
    console.error("[oauth/instagram/callback]", e);
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?error=oauth_failed`
    );
  }
}
