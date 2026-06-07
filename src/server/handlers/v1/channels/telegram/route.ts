import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { upsertChannels } from "@/lib/channels/upsert";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { created, ApiErrors } from "@/lib/api/response";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { env } from "@/lib/env";
import type { TelegramProvider } from "@/lib/platforms/telegram";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  // BotFather tokens look like 1234567890:AA... — validate the shape before hitting the API.
  token: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "That doesn't look like a Telegram bot token"),
});

// POST /api/v1/channels/telegram/connect — connect a Telegram bot by token
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error.flatten().fieldErrors);

  const provider = getProvider("telegram") as TelegramProvider;
  let accounts;
  try {
    accounts = await provider.connectWithToken(parsed.data.token);
  } catch {
    return ApiErrors.badRequest("Invalid bot token — create one with @BotFather and paste it here");
  }

  await upsertChannels(auth.workspaceId, "telegram", accounts, { connectionMode: "manual_token" });

  // Register the webhook with the channel's stored secret so incoming updates verify.
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.workspace_id, auth.workspaceId), eq(channels.platform_id, accounts[0].platformId)),
    columns: { webhook_secret: true },
  });
  if (channel?.webhook_secret) {
    await provider.setWebhook(parsed.data.token, `${env.APP_URL}/api/webhooks/telegram`, channel.webhook_secret);
  }

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelConnected,
    targetType: "channel",
    metadata: { platform: "telegram", mode: "manual_token" },
  });

  return created({ connected: accounts.length, username: accounts[0].username ?? null });
}
