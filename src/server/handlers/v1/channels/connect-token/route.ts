import { authenticateWithScope } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { MetaTokenError } from "@/lib/platforms/meta-token";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(["facebook", "instagram"]),
  token: z.string().min(20),
});

// POST /api/v1/channels/connect-token — connect a channel with a pasted
// long-lived / System User token instead of OAuth.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error);
  }

  const provider = getProvider(parsed.data.platform);
  if (!provider.connectWithToken) {
    return ApiErrors.badRequest("Platform does not support manual token connection");
  }

  let accounts;
  try {
    accounts = await provider.connectWithToken(parsed.data.token);
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

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelConnected,
    targetType: "channel",
    metadata: { platform: parsed.data.platform, mode: "manual_token", connected: accounts.length },
  });

  return created({ connected: accounts.length });
}
