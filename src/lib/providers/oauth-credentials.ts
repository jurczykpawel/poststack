import { getConfig } from "@/lib/settings/config";
import { PUBLISHING_OAUTH } from "@/lib/settings/publishing-oauth";

export async function oauthCredentials(provider: keyof typeof PUBLISHING_OAUTH) {
  const [id, secret] = PUBLISHING_OAUTH[provider].keys;
  const [clientId, clientSecret] = await Promise.all([getConfig(id), getConfig(secret)]);
  return { clientId, clientSecret };
}
