import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
} from "./base";
import { TokenInvalidError, MessagingPolicyError } from "./errors";

const TELEGRAM_API = "https://api.telegram.org";

/** A 401 means the bot token itself was revoked/regenerated via BotFather — the connection is
 *  dead for every chat and needs operator re-auth. (403 is NOT here: it's per-chat — see
 *  isTelegramChatUnavailable — and must not flag the whole channel.) */
function isTelegramAuthFailure(status: number, errorCode?: number): boolean {
  return status === 401 || errorCode === 401;
}

/** A 403 is per-chat, not per-token: "bot was blocked by the user", "bot was kicked", "user is
 *  deactivated". The token is still valid for every other chat, so this delivery is dropped
 *  terminally (like a Meta policy block) instead of parking the whole channel for re-auth. */
function isTelegramChatUnavailable(status: number, errorCode?: number): boolean {
  return status === 403 || errorCode === 403;
}

/** A 400 carrying one of these descriptions is a PERMANENT per-chat failure: retrying the identical
 *  send can never succeed. Drop just this delivery terminally (like a 403) instead of dead-lettering
 *  every attempt — per-chat, NOT per-token, so the channel is never flagged for re-auth (symmetric
 *  with isTelegramChatUnavailable). Matched as lowercase substrings of body.description.
 *  Deliberately EXCLUDES content bugs ("message is too long", "can't parse entities") — those signal
 *  OUR payload, not a policy drop, and silently dropping them would mask a real bug — and any unknown
 *  400 (left transient/retryable). */
const TELEGRAM_PERMANENT_400_MARKERS = [
  "chat not found",
  "have no rights to send",
  "chat_write_forbidden",
  "group chat was upgraded to a supergroup",
  "reply message not found",
];
function isTelegramPermanentBadRequest(status: number, description?: string): boolean {
  if (status !== 400 || !description) return false;
  const d = description.toLowerCase();
  return TELEGRAM_PERMANENT_400_MARKERS.some((m) => d.includes(m));
}

/** Narrow shapes of the Telegram Bot API objects we actually read. */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string; username?: string };
  date: number;
  text?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/**
 * Telegram Bot API provider. No OAuth: the user pastes a bot token from
 * @BotFather, which we validate via getMe and wire up via setWebhook. Bot
 * tokens do not expire and there is no comment surface.
 */
export class TelegramProvider extends SocialProvider {
  readonly platform = "telegram" as const;
  readonly displayName = "Telegram";

  private base(token: string): string {
    return `${TELEGRAM_API}/bot${token}`;
  }

  generateAuthUrl(): string {
    throw new Error("Telegram does not use OAuth — connect with a bot token (connectWithToken)");
  }

  async authenticate(): Promise<ConnectedAccount[]> {
    throw new Error("Telegram does not use OAuth — connect with a bot token (connectWithToken)");
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    return tokens; // bot tokens never expire
  }

  requiresTokenRefresh(): boolean {
    return false;
  }

  /**
   * Validate a bot token (getMe) and register the webhook. `webhookSecret` is
   * echoed back by Telegram in the X-Telegram-Bot-Api-Secret-Token header so we
   * can verify incoming updates.
   */
  override async connectWithToken(token: string): Promise<ConnectedAccount[]> {
    const me = await this.getMe(token);
    return [
      {
        platformId: String(me.id),
        displayName: me.first_name || me.username || `bot ${me.id}`,
        username: me.username,
        tokens: { access_token: token },
      },
    ];
  }

  /** GET /getMe — also the token validity check. */
  async getMe(token: string): Promise<TelegramUser> {
    const res = await fetch(`${this.base(token)}/getMe`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: TelegramUser; description?: string };
    if (!res.ok || !body.ok || !body.result) {
      throw new Error(`Invalid Telegram bot token: ${body.description ?? res.status}`);
    }
    return body.result;
  }

  /**
   * Register the webhook so Telegram POSTs updates to us. The secret_token is
   * returned in a header on every update for verification. Throws on failure —
   * a bot without a registered webhook has a silently dead inbox, so the caller
   * must treat this as a failed connection.
   */
  async setWebhook(token: string, url: string, secretToken: string): Promise<void> {
    const res = await fetch(`${this.base(token)}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ["message"] }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; error_code?: number };
    if (!res.ok || !body.ok) {
      if (isTelegramAuthFailure(res.status, body.error_code)) {
        throw new TokenInvalidError(`Telegram bot token rejected: ${body.description ?? res.status}`);
      }
      throw new Error(`Telegram setWebhook failed: ${body.description ?? res.status}`);
    }
  }

  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent,
  ): Promise<SentMessage> {
    const res = await fetch(`${this.base(tokens.access_token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: recipientId, text: content.text ?? "" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id: number }; description?: string; error_code?: number };
    if (!res.ok || !body.ok || !body.result) {
      // A revoked/regenerated bot token (401) is a re-auth case — type it so the delivery state
      // machine parks + flags the channel needs_reauth instead of retrying to dead-letter.
      if (isTelegramAuthFailure(res.status, body.error_code)) {
        throw new TokenInvalidError(`Telegram bot token rejected: ${body.description ?? res.status}`);
      }
      // A 403 is per-chat (this user blocked/kicked the bot, or is deactivated): the token still
      // works for everyone else. Drop just this delivery terminally instead of taking the whole
      // channel offline. The delivery state machine records it `expired`, no retry.
      if (isTelegramChatUnavailable(res.status, body.error_code)) {
        throw new MessagingPolicyError(`Telegram chat unavailable: ${body.description ?? res.status}`);
      }
      // A 400 with a known permanent description (chat not found, no rights / CHAT_WRITE_FORBIDDEN,
      // group upgraded to supergroup, reply message not found) is a per-chat terminal — retrying the
      // identical send can't fix it. Drop it (like a 403), don't park the whole channel. Unknown 400s
      // and content bugs (too long / parse) fall through to the retryable generic error.
      if (isTelegramPermanentBadRequest(res.status, body.description)) {
        throw new MessagingPolicyError(`Telegram chat unavailable (permanent): ${body.description ?? res.status}`);
      }
      throw new Error(`Telegram send message failed: ${body.description ?? res.status}`);
    }
    return { platformMessageId: String(body.result.message_id) };
  }
}
