import type { Platform } from "@/db/schema";
import type { SessionAuthContext } from "@/lib/auth";
import { encryptString, decryptString } from "@/lib/crypto";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { getProviderForPlatform, platformForConnectId } from "@/lib/providers";
import { fromTokenSet } from "@/lib/providers/token-codec";
import type { TokenSet } from "@/lib/providers/types";
import { assertChannelsAllowed, upsertChannels } from "@/lib/channels/upsert";
import { oauthCookie, readCookie } from "./state";

/**
 * "Connect pages" picker (e.g. LinkedIn Company Pages). The OAuth callback parks the freshly issued
 * token in a short-lived encrypted HttpOnly cookie bound to the session; the picker lists the member
 * profile + the provider's sub-accounts and connects only what the user ticks. Options are always
 * re-read from the provider, so a submitted id is accepted only if that token can really post there.
 */
const COOKIE = "rs_oauth_pick";
const PATH = "/channels/pick";
const MAX_AGE = 10 * 60;
const PERSON = "person";

// encryptString's hex parts re-encoded as base64url to keep the cookie well under 4 KB.
const pack = (enc: string) => enc.split(":").map((h) => Buffer.from(h, "hex").toString("base64url")).join(".");
const unpack = (v: string) => v.split(".").map((b) => Buffer.from(b, "base64url").toString("hex")).join(":");

export function pickCookie(platform: string, tokens: TokenSet, auth: SessionAuthContext): string {
  const payload = { platform, ws: auth.workspaceId, user: auth.userId, session: auth.sessionId, exp: Date.now() + MAX_AGE * 1000, tokens };
  return oauthCookie(COOKIE, pack(encryptString(JSON.stringify(payload))), MAX_AGE, PATH);
}

export const clearPickCookie = () => oauthCookie(COOKIE, "", 0, PATH);

/** The parked token, or null when absent, expired, or issued to another session/platform. */
export function readPick(cookieHeader: string | null, platform: string, auth: SessionAuthContext): TokenSet | null {
  const raw = readCookie(cookieHeader, COOKIE);
  if (!raw) return null;
  try {
    const p = JSON.parse(decryptString(unpack(raw))) as { platform: string; ws: string; user: string; session: string; exp: number; tokens: TokenSet };
    const valid = p.platform === platform && p.ws === auth.workspaceId && p.user === auth.userId &&
      p.session === auth.sessionId && p.exp > Date.now() && typeof p.tokens?.accessToken === "string";
    return valid ? p.tokens : null;
  } catch {
    return null;
  }
}

export interface PickOption { value: string; kind: "person" | "page"; name: string; account: ConnectedAccount }

/** The member profile (always first) followed by every page the token can publish to. */
export async function listPickOptions(platform: string, tokens: TokenSet): Promise<PickOption[]> {
  const provider = getProviderForPlatform(platformForConnectId(platform));
  const me = await provider.healthCheck(tokens);
  const pages = (await provider.enumerateSubAccounts?.(tokens)) ?? [];
  const td = fromTokenSet(tokens);
  return [
    { value: PERSON, kind: "person", name: me.displayName ?? me.accountId,
      account: { platformId: me.accountId, displayName: me.displayName ?? me.accountId, profilePicture: me.avatarUrl, tokens: td } },
    ...pages.map((p): PickOption => ({ value: `page:${p.providerAccountId}`, kind: "page", name: p.displayName ?? p.providerAccountId,
      account: { platformId: p.providerAccountId, displayName: p.displayName ?? p.providerAccountId, tokens: fromTokenSet(p.token), metadata: p.metadata } })),
  ];
}

/** Connect the ticked options as channels (one per account). Returns how many were connected. */
export async function connectPicked(platform: string, tokens: TokenSet, auth: SessionAuthContext, values: string[]): Promise<number> {
  const accounts = (await listPickOptions(platform, tokens)).filter((o) => values.includes(o.value)).map((o) => o.account);
  if (!accounts.length) return 0;
  const channelPlatform = platformForConnectId(platform) as Platform;
  await assertChannelsAllowed(auth.workspaceId, channelPlatform, accounts);
  await upsertChannels(auth.workspaceId, channelPlatform, accounts, { connectionMode: "oauth" });
  return accounts.length;
}
