import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
} from "./base";
import { TokenInvalidError } from "./errors";

const TELEGRAM_API = "https://api.telegram.org";

/** Telegram returns 401 once a bot token is revoked/regenerated via BotFather, and 403 when
 *  the bot is blocked/kicked — both mean the connection needs operator action, not a retry. */
function isTelegramAuthFailure(status: number, errorCode?: number): boolean {
  return status === 401 || status === 403 || errorCode === 401 || errorCode === 403;
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
      // A revoked/regenerated bot token (401) or a blocked bot (403) is a re-auth case, not a
      // transient failure — type it so the delivery state machine parks + flags needs_reauth
      // instead of retrying to the dead-letter queue.
      if (isTelegramAuthFailure(res.status, body.error_code)) {
        throw new TokenInvalidError(`Telegram bot token rejected: ${body.description ?? res.status}`);
      }
      throw new Error(`Telegram send message failed: ${body.description ?? res.status}`);
    }
    return { platformMessageId: String(body.result.message_id) };
  }
}
