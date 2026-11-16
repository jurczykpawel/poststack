import { getConfig } from "@/lib/settings/config";
import { historyRetentionField } from "@/lib/env";
import { getProvider, listProviders } from "@/lib/providers";
import { GMAIL_OAUTH_SCOPES } from "@/lib/platforms/gmail";
import { FACEBOOK_OAUTH_SCOPES } from "@/lib/platforms/facebook";
import { INSTAGRAM_OAUTH_SCOPES } from "@/lib/platforms/instagram";
import { IG_LOGIN_SCOPES } from "@/lib/platforms/instagram-login";
import { resolveGoogleApp } from "@/lib/platforms/google-oauth";
import { YOUTUBE_OAUTH_SCOPE } from "@/lib/youtube/client";

export interface PublicIntegration { id: string; name: string; scopes: readonly string[]; formats: string[] }
export async function publicSiteConfig() {
  const integrations: PublicIntegration[] = [];
  for (const provider of listProviders()) {
    if (!provider.oauthConfig && provider.id !== "telegram") continue;
    const oauth = await provider.oauthConfig?.();
    if (!oauth && provider.id !== "telegram") continue;
    integrations.push({ id: provider.id, name: provider.label, scopes: oauth?.scopes ?? [], formats: provider.capabilities(provider.id).map(c => c.format) });
  }
  const pair = async (id: string, secret: string) => (await Promise.all([getConfig(id), getConfig(secret)])).every(Boolean);
  const meta = await pair("META_APP_ID", "META_APP_SECRET");
  const ig = await pair("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET");
  if (meta) integrations.push({ id: "facebook", name: "Facebook", scopes: FACEBOOK_OAUTH_SCOPES, formats: getProvider("meta").capabilities("facebook").map(c => c.format) });
  if (meta || ig) integrations.push({ id: "instagram", name: "Instagram", scopes: [...(meta ? INSTAGRAM_OAUTH_SCOPES : []), ...(ig ? IG_LOGIN_SCOPES : [])], formats: getProvider("meta").capabilities("instagram").map(c => c.format) });
  const google = await resolveGoogleApp("");
  if (google.clientId && google.clientSecret) {
    integrations.push({ id: "gmail", name: "Gmail", scopes: GMAIL_OAUTH_SCOPES, formats: [] });
  }
  if (await pair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")) {
    const youtube = integrations.find(i => i.id === "youtube");
    if (youtube) youtube.scopes = [...youtube.scopes, YOUTUBE_OAUTH_SCOPE];
    else integrations.push({ id: "youtube", name: "YouTube", scopes: [YOUTUBE_OAUTH_SCOPE], formats: [] });
  }
  return { integrations, retentionDays: historyRetentionField.parse(process.env.HISTORY_RETENTION_DAYS) };
}
export type PublicSiteConfig = Awaited<ReturnType<typeof publicSiteConfig>>;
