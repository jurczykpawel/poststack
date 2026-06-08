import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { addJob } from "@/lib/queue/client";
import type { TelegramUpdate } from "@/lib/platforms/telegram";

export const runtime = "nodejs";

/**
 * Telegram webhook. The payload does not name the receiving bot, so we identify
 * (and authenticate) the channel by the per-channel secret Telegram echoes in
 * the X-Telegram-Bot-Api-Secret-Token header (set during connect via setWebhook).
 *
 * Telegram retries for ~1h on non-200. Non-retryable conditions (no/unknown
 * secret, unsupported update type) return 200 so they aren't re-sent. But a
 * transient failure (DB lookup or enqueue throwing) returns 500 so the update is
 * retried instead of silently dropped; the per-update jobKey keeps retries
 * idempotent.
 */
export async function POST(request: Request): Promise<Response> {
  const ok = () => new Response("ok", { status: 200 });
  const retry = () => new Response("error", { status: 500 });

  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret) return ok();

  let channel: { id: string; platform_id: string } | undefined;
  try {
    channel = await db.query.channels.findFirst({
      where: and(eq(channels.webhook_secret, secret), eq(channels.platform, "telegram"), ne(channels.status, "disabled")),
      columns: { id: true, platform_id: true },
    });
  } catch (err) {
    console.error("[telegram webhook] channel lookup failed:", err);
    return retry(); // transient — let Telegram redeliver
  }
  if (!channel) return ok();

  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const msg = update?.message;
  // MVP: only plain text messages. edited_message / callback_query / etc. are ignored.
  if (!update || !msg || !msg.text) return ok();

  // message_id is unique only per chat, so identity must include bot + chat to
  // avoid cross-chat dedup collisions dropping messages.
  const identity = `${channel.platform_id}-${msg.chat.id}-${msg.message_id}`;
  try {
    await addJob(
      "incoming-message",
      {
        platform: "telegram",
        channelId: channel.id, // webhook already verified the channel — route deterministically
        pageId: channel.platform_id,
        senderId: String(msg.chat.id),
        recipientId: channel.platform_id,
        mid: identity,
        text: msg.text,
        // seconds — the worker converts to a Date (×1000); do NOT pre-multiply.
        timestamp: msg.date ?? Math.floor(Date.now() / 1000),
        raw: update as unknown as Record<string, unknown>,
      },
      { jobKey: `tg-${identity}` },
    );
  } catch (err) {
    console.error("[telegram webhook] enqueue failed:", err);
    return retry(); // transient — let Telegram redeliver (jobKey dedups)
  }
  return ok();
}
