import type { AccountInfo, FormatCapability, Provider, PublishHandle, PublishRequest, TokenSet } from "./types";
import { PermanentError, PermissionError, TransientError, type PublishPhase } from "./errors";
import { classifyHttp } from "./http";
import { asString } from "./util";

const API = "https://api.telegram.org";
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

// Bot API "Sending files": by URL, photos up to 5 MB and other content up to 20 MB.
const CAPS: FormatCapability[] = [
  { format: "text", media: { min: 0, max: 0, kinds: [] }, caption: { maxLength: TEXT_LIMIT, required: true }, mediaIngestion: "pull_url" },
  { format: "image", media: { min: 1, max: 1, kinds: ["image"] }, image: { maxSizeMB: 5 }, caption: { maxLength: CAPTION_LIMIT, required: false }, mediaIngestion: "pull_url" },
  { format: "video", media: { min: 1, max: 1, kinds: ["video"] }, video: { maxSizeMB: 20 }, caption: { maxLength: CAPTION_LIMIT, required: false }, mediaIngestion: "pull_url" },
  { format: "carousel", media: { min: 2, max: 10, kinds: ["image", "video"] }, image: { maxSizeMB: 5 }, video: { maxSizeMB: 20 }, caption: { maxLength: CAPTION_LIMIT, required: false }, mediaIngestion: "pull_url" },
];

const PERMISSION_HINT = "Add the bot as an administrator of the channel with permission to post messages";
const PERMISSION_MARKERS = ["not enough rights", "have no rights", "not a member", "chat_write_forbidden", "chat not found", "bot was kicked"];

type TgBody = { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };

async function call(token: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new TransientError(`telegram ${method}: network error`);
  }
  const body = (await res.json().catch(() => ({}))) as TgBody;
  if (res.ok && body.ok) return body.result;
  const description = body.description ?? String(res.status);
  if (PERMISSION_MARKERS.some((m) => description.toLowerCase().includes(m))) {
    throw new PermissionError(`${PERMISSION_HINT} (${description})`);
  }
  // A 429 is rejected before anything is sent, so the whole publish can safely be re-run.
  const phase: PublishPhase = res.status === 429 ? "pre_commit" : "commit_uncertain";
  throw classifyHttp(res.status, description, phase, { provider: "telegram", headers: res.headers, body });
}

const messageId = (m: unknown): string | undefined => {
  const id = (m as { message_id?: unknown } | null)?.message_id;
  return typeof id === "number" && Number.isSafeInteger(id) ? String(id) : undefined;
};

/** Syntax check of a "publish to" value (no network); returns the trimmed value. */
export function parsePublishTarget(input: string): string {
  const target = input.trim();
  if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(target) && !/^-?\d{5,20}$/.test(target)) {
    throw new PermanentError("Enter a channel @username or a numeric chat id");
  }
  return target;
}

/** Validate the "publish to" target for a bot token and return its stable form (@username or chat id). */
export async function resolvePublishTarget(token: string, input: string): Promise<string> {
  const target = parsePublishTarget(input);
  const me = (await call(token, "getMe", {})) as { id?: number };
  const chat = (await call(token, "getChat", { chat_id: target })) as { id?: number; type?: string; username?: string };
  if (chat.type === "private" || !chat.id) throw new PermanentError("Target must be a channel or a group");
  const member = (await call(token, "getChatMember", { chat_id: target, user_id: me.id })) as { status?: string; can_post_messages?: boolean; can_send_messages?: boolean };
  const isChannel = chat.type === "channel";
  const allowed = member.status === "creator" ||
    (member.status === "administrator" && (!isChannel || member.can_post_messages === true)) ||
    (!isChannel && (member.status === "member" || (member.status === "restricted" && member.can_send_messages !== false)));
  if (!allowed) throw new PermissionError(isChannel ? `${PERMISSION_HINT}.` : "The bot is not allowed to write in this group.");
  return chat.username ? `@${chat.username}` : String(chat.id);
}

export const telegramProvider: Provider = {
  id: "telegram",
  label: "Telegram",
  capabilities: () => CAPS,
  connectionModes: () => ["manual_token"],
  requiresTokenRefresh: () => false,
  refreshToken: async (tokens: TokenSet) => tokens,

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const me = (await call(tokens.accessToken, "getMe", {})) as { id?: unknown; first_name?: string; username?: string };
    const accountId = typeof me.id === "number" ? String(me.id) : undefined;
    if (!accountId) throw classifyHttp(404, "no telegram bot");
    return { accountId, displayName: me.first_name ?? me.username, handle: me.username };
  },

  async publish({ tokens, request, mediaUrls, mediaKinds, channelMetadata }): Promise<PublishHandle> {
    const target = asString(channelMetadata?.publishTarget);
    if (!target) throw new PermanentError("Telegram publish target is not set — set it in the channel settings");
    const caption = request.caption || undefined;
    const limit = request.format === "text" ? TEXT_LIMIT : CAPTION_LIMIT;
    if (caption && caption.length > limit) throw new PermanentError(`telegram: text exceeds ${limit} characters`);
    const [method, payload] = buildCall(request, target, caption, mediaUrls, mediaKinds);
    const result = await call(tokens.accessToken, method, payload);
    const ids = (Array.isArray(result) ? result : [result]).map(messageId);
    if (!ids.length || ids.some((id) => !id)) throw new TransientError("telegram: response had no message_id");
    const first = ids[0]!;
    return { providerHandle: ids.join(","), ...(target.startsWith("@") ? { url: `https://t.me/${target.slice(1)}/${first}` } : {}) };
  },
};

function buildCall(request: PublishRequest, chat_id: string, caption: string | undefined, urls: string[], kinds?: string[]): [string, Record<string, unknown>] {
  const cap = caption ? { caption } : {};
  switch (request.format) {
    case "text": return ["sendMessage", { chat_id, text: caption ?? "" }];
    case "image": return ["sendPhoto", { chat_id, photo: urls[0], ...cap }];
    case "video": return ["sendVideo", { chat_id, video: urls[0], supports_streaming: true, ...cap }];
    case "carousel":
      return ["sendMediaGroup", { chat_id, media: urls.map((media, i) => ({ type: kinds?.[i] === "video" ? "video" : "photo", media, ...(i === 0 ? cap : {}) })) }];
    default: throw new PermanentError(`telegram: unsupported format '${request.format}'`);
  }
}
