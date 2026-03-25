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

  // User denied the permission dialog
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

  // Verify CSRF state
  try {
    await verifyOAuthState(state);
  } catch {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?error=invalid_state`
    );
  }

  // Must be authenticated (session cookie present)
  const auth = await authenticate(request).catch(() => null);
  if (!auth) {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?redirect=/channels`
    );
  }

  try {
    const provider = getProvider("facebook");
    const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/oauth/facebook/callback`;
    const accounts = await provider.authenticate(code, redirectUri);

    if (accounts.length === 0) {
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/channels?error=no_pages`
      );
    }

    await upsertChannels(auth.workspaceId, "facebook", accounts);

    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?connected=facebook&count=${accounts.length}`
    );
  } catch (e) {
    console.error("[oauth/facebook/callback]", e);
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/channels?error=oauth_failed`
    );
  }
}
