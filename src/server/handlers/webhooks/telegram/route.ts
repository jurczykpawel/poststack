import { createHash, timingSafeEqual } from "crypto";
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
// A Telegram update is tiny; cap the body before buffering it (post-auth, so lower risk than
// the Meta webhook, but still unbounded otherwise). Oversized → 200 (ignored, not retried).
const MAX_TELEGRAM_BODY_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
  const ok = () => new Response("ok", { status: 200 });
  const retry = () => new Response("error", { status: 500 });

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_BODY_BYTES) return ok();

  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret) return ok();

  let channel: { id: string; platform_id: string } | undefined;
  try {
    // Identify the channel by the per-channel secret, but compare it constant-time in Node rather
    // than via SQL `eq` (Postgres `text =` is not guaranteed constant-time). The secret is 256-bit
    // server-minted so a timing oracle is infeasible — this keeps the compare consistent with the
    // other three secret checks (Meta sig/verify-token, CRON), all timingSafeEqual. The
    // candidate set is operator-sized (Telegram channels in this self-host), so the scan is cheap.
    const digest = (v: string) => createHash("sha256").update(v).digest();
    const provided = digest(secret);
    const candidates = await db.query.channels.findMany({
      where: and(eq(channels.platform, "telegram"), ne(channels.status, "disabled")),
      columns: { id: true, platform_id: true, webhook_secret: true },
    });
    channel = candidates.find((c) => timingSafeEqual(provided, digest(c.webhook_secret)));
  } catch (err) {
    console.error("[telegram webhook] channel lookup failed:", err);
    return retry(); // transient — let Telegram redeliver
  }
  if (!channel) return ok();

  // Read the body with the cap enforced on ACTUAL bytes, not just the declared Content-Length
  // (a chunked/header-less request bypasses the early check). Oversized → 200 ignored.
  const rawBody = await request.text().catch(() => "");
  if (Buffer.byteLength(rawBody) > MAX_TELEGRAM_BODY_BYTES) return ok();
  let update: TelegramUpdate | null = null;
  try {
    update = rawBody ? (JSON.parse(rawBody) as TelegramUpdate) : null;
  } catch {
    update = null;
  }
  const msg = update?.message;
  // MVP: only plain text messages. edited_message / callback_query / etc. are ignored.
  if (!update || !msg || !msg.text) return ok();
  // Guard `chat` before building the identity from `msg.chat.id`: a text message without a
  // `chat` (odd service/business update) would otherwise TypeError → 500 → ~1h retry.
  if (!msg.chat?.id) return ok();
  // Only private (1:1) chats: in a group/supergroup/channel, chat.id is the GROUP, not a member,
  // so using it as the sender identity would collapse every member into one contact and aim
  // replies at the whole group. ReplyStack is a DM inbox — non-private chats are out of scope, so
  // ignore them (200, not retried).
  if (msg.chat.type !== "private") return ok();

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
      },
      { jobKey: `tg-${identity}` },
    );
  } catch (err) {
    console.error("[telegram webhook] enqueue failed:", err);
    return retry(); // transient — let Telegram redeliver (jobKey dedups)
  }
  return ok();
}
