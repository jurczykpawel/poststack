import { authenticateWithScope } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { MetaTokenError } from "@/lib/platforms/meta-token";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { subscribeChannelWebhooks } from "@/lib/channels/subscribe";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";
import { connectTikTokToken } from "@/lib/providers/tiktok";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("platform", [z.object({
  platform: z.enum(["facebook", "instagram"]),
  token: z.string().min(20),
}), z.object({
  platform: z.literal("tiktok"),
  access_token: z.string().trim().min(1).max(4096),
  refresh_token: z.string().trim().min(1).max(4096),
  client_key: z.string().trim().min(1).max(256),
  client_secret: z.string().trim().min(1).max(4096),
})]);

// POST /api/v1/channels/connect-token — connect with a pasted Meta or TikTok token.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "channels:write");
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error);
  }

  let accounts;
  try {
    if (parsed.data.platform === "tiktok") accounts = await connectTikTokToken(parsed.data);
    else {
      const provider = getProvider(parsed.data.platform);
      if (!provider.connectWithToken) return ApiErrors.badRequest("Platform does not support manual token connection");
      accounts = await provider.connectWithToken(parsed.data.token);
    }
  } catch (err) {
    // A MetaTokenError carries a specific, user-facing reason (foreign app / invalid / expired /
    // missing scope) — surface it. Anything else stays a generic message.
    if (err instanceof MetaTokenError) return ApiErrors.badRequest(err.message);
    return ApiErrors.badRequest("Token validation failed — check the token and its permissions");
  }
  if (accounts.length === 0) {
    return ApiErrors.badRequest("No pages or accounts are accessible with this token");
  }

  await assertChannelsAllowed(auth.workspaceId, parsed.data.platform, accounts);
  await upsertChannels(auth.workspaceId, parsed.data.platform, accounts, {
    connectionMode: "manual_token",
  });
  // Auto-subscribe to inbound webhook events, same path as the OAuth callbacks + the managed-connection
  // mint, so a pasted-token channel both publishes AND receives on one row (best-effort; flags any
  // that fail rather than failing the connect).
  if (parsed.data.platform !== "tiktok") await subscribeChannelWebhooks(auth.workspaceId, parsed.data.platform, accounts);

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelConnected,
    targetType: "channel",
    metadata: { platform: parsed.data.platform, mode: "manual_token", connected: accounts.length },
  });

  return created({ connected: accounts.length });
}
