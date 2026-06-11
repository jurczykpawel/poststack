import { and, eq, inArray } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { getProvider } from "@/lib/platforms/registry";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { addJob } from "@/lib/queue/client";
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

  // Non-Meta channels (Telegram) are a PRO feature — propagates a 402 when unlicensed.
  await assertChannelsAllowed(auth.workspaceId, "telegram", accounts);

  // Defer draining any parked messages until setWebhook confirms the inbox works —
  // otherwise a reconnect would flush held messages through a channel whose webhook
  // ends up failing.
  const { recoveredChannelIds } = await upsertChannels(
    auth.workspaceId,
    "telegram",
    accounts,
    { connectionMode: "manual_token", deferDrain: true },
  );

  // Register the webhook with the channel's stored secret so incoming updates verify.
  // A bot without a working webhook has a dead inbox — treat failure as a failed
  // connection: flag the channel needs_reauth and report the error.
  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.workspace_id, auth.workspaceId),
      eq(channels.platform, "telegram"),
      eq(channels.platform_id, accounts[0].platformId),
    ),
    columns: { id: true, webhook_secret: true },
  });
  try {
    if (!channel?.webhook_secret) throw new Error("channel webhook secret missing after upsert");
    await provider.setWebhook(parsed.data.token, `${env.APP_URL}/api/webhooks/telegram`, channel.webhook_secret);
  } catch {
    if (channel) {
      await db.update(channels)
        .set({ status: "needs_reauth", last_error: "Telegram webhook registration failed" })
        .where(eq(channels.id, channel.id));
    }
    return ApiErrors.badRequest("Bot connected but webhook registration failed — check the token and try again");
  }

  // Webhook is live — now it's safe to flush anything parked while the bot was down.
  // If the drain can't be scheduled, the channel is already active but its held
  // messages have nothing to flush them: a later reconnect won't re-recover an
  // already-active channel. Roll the un-drained channels back to needs_reauth so the
  // next reconnect re-recovers them and retries the drain, rather than stranding them.
  const drained: string[] = [];
  try {
    for (const channelId of recoveredChannelIds) {
      // Deterministic jobKey (matches health.ts / upsert.ts / the PATCH route) so a double-click
      // reconnect coalesces to a single drain instead of two uncoordinated ones.
      await addJob("drain-channel", { channelId }, { jobKey: `drain-channel:${channelId}` });
      drained.push(channelId);
    }
  } catch {
    const stranded = recoveredChannelIds.filter((id) => !drained.includes(id));
    if (stranded.length > 0) {
      await db.update(channels)
        .set({ status: "needs_reauth", last_error: "Held-message drain could not be scheduled — reconnect to retry" })
        .where(inArray(channels.id, stranded));
    }
    return ApiErrors.badRequest("Bot connected but queuing held messages failed — try connecting again");
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
