import { env } from "@/lib/env";
import { GRAPH_API_BASE } from "./constants";

interface DebugTokenResponse {
  data?: { app_id?: string; is_valid?: boolean };
}

/**
 * Validate that a pasted Meta access token belongs to THIS app and is currently valid, via
 * `GET /debug_token`. Throws a clear error for a foreign-app / invalid / expired token so a manual
 * connect fails fast with a useful message instead of storing a token that dead-letters every send
 * and only later flips the channel to needs_reauth.
 *
 * No-op (skips validation) when:
 *  - the app credentials aren't configured (can't call debug_token), or
 *  - the debug_token call itself doesn't succeed (a Meta-side hiccup must not block a connect that
 *    would otherwise work — we only reject on a CONFIRMED foreign-app / invalid token).
 */
export async function assertMetaTokenBelongsToApp(token: string): Promise<void> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) return;

  let res: Response;
  try {
    res = await fetch(
      `${GRAPH_API_BASE}/debug_token?` +
        new URLSearchParams({
          input_token: token,
          access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}`,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return; // network/timeout — don't block connect on a transient debug_token failure
  }
  if (!res.ok) return;

  const data = ((await res.json().catch(() => ({}))) as DebugTokenResponse).data;
  if (!data) return;
  if (data.is_valid === false) {
    throw new Error("This access token is invalid or expired");
  }
  if (data.app_id && String(data.app_id) !== String(env.META_APP_ID)) {
    throw new Error("This access token belongs to a different Facebook app");
  }
}
