import type { Platform } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import {
  type ConnectedAccount,
  type MessageContent,
  type SendMessageOptions,
  type SentMessage,
  type TokenData,
} from "./base";
import { EmailProvider, type NormalizedEmail } from "./email";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  refreshGoogleToken,
  resolveGoogleApp,
} from "./google-oauth";

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPart;
}

function decodeBase64Url(data?: string): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

/** RFC 2047 encoded-word for a header value carrying non-ASCII (e.g. Polish diacritics in a Subject).
 *  Pure-ASCII values are left as-is so they stay human-readable on the wire. */
function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Recursive MIME walker: collects the first text/plain and text/html across the part tree,
 *  including the single-part case where the body sits on the payload itself. */
function extractBodies(part?: GmailPart): { plain?: string; html?: string } {
  if (!part) return {};
  const out: { plain?: string; html?: string } = {};
  const walk = (p: GmailPart): void => {
    if (p.mimeType === "text/plain" && out.plain === undefined) {
      out.plain = decodeBase64Url(p.body?.data);
    } else if (p.mimeType === "text/html" && out.html === undefined) {
      out.html = decodeBase64Url(p.body?.data);
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  return out;
}

export class GmailProvider extends EmailProvider {
  readonly platform = "gmail" as const satisfies Platform;
  readonly displayName = "Gmail";

  async generateAuthUrl(state: string, redirectUri: string): Promise<string> {
    // resolveGoogleApp ignores workspaceId in v1 (instance-level env) — "" is fine.
    const app = await resolveGoogleApp("");
    return buildGoogleAuthUrl(app, redirectUri, state, SCOPES);
  }

  async authenticate(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    const app = await resolveGoogleApp("");
    const tokens = await exchangeGoogleCode(code, redirectUri, app);
    const res = await fetch(`${API}/profile`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = (await res.json()) as { emailAddress?: string };
    if (!res.ok || !profile.emailAddress) {
      throw new Error(`gmail: profile fetch failed (${res.status})`);
    }
    return [
      {
        platformId: profile.emailAddress,
        displayName: profile.emailAddress,
        username: profile.emailAddress,
        tokens,
      },
    ];
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    if (!tokens.refresh_token) {
      throw new Error("gmail: no refresh_token (reconnect with prompt=consent)");
    }
    const app = await resolveGoogleApp("");
    const fresh = await refreshGoogleToken(tokens.refresh_token, app);
    // Google omits refresh_token on refresh — keep the stored one.
    return { ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token };
  }

  requiresTokenRefresh(): boolean {
    return true;
  }

  canonicalizeAddress(addr: string): string {
    const lowered = addr.trim().toLowerCase();
    const at = lowered.lastIndexOf("@");
    if (at < 0) return lowered;
    const localRaw = lowered.slice(0, at);
    const domainRaw = lowered.slice(at + 1);
    const domain = domainRaw === "googlemail.com" ? "gmail.com" : domainRaw;
    let local = localRaw.split("+")[0];
    if (domain === "gmail.com") local = local.replace(/\./g, "");
    return `${local}@${domain}`;
  }

  buildRawMessage(m: {
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string;
  }): { raw: string } {
    const headers = [
      `To: ${m.to}`,
      `Subject: ${encodeHeaderWord(m.subject)}`,
      "Content-Type: text/plain; charset=UTF-8",
      ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
      ...(m.references ? [`References: ${m.references}`] : []),
    ];
    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${m.text}`, "utf8").toString("base64url");
    return { raw };
  }

  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent,
    opts?: SendMessageOptions
  ): Promise<SentMessage> {
    const email = opts?.email;
    const { raw } = this.buildRawMessage({
      to: recipientId,
      subject: email?.subject || "(no subject)",
      text: content.text ?? "",
      inReplyTo: email?.inReplyTo,
      references: email?.inReplyTo,
    });
    const body = email?.threadId ? { raw, threadId: email.threadId } : { raw };
    const res = await fetch(`${API}/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { id?: string };
    if (!res.ok) throw new Error(`gmail: send failed (${res.status})`);
    return { platformMessageId: j.id ?? null };
  }

  async listNewMessages(
    channel: {
      id: string;
      gmail_query: string | null;
      gmail_sync_cursor: string | null;
      token_encrypted: string;
      workspace_id: string;
    },
    cursor: string | null
  ): Promise<string[]> {
    const access = decryptTokens(channel.token_encrypted).access_token;
    const after = cursor ? ` after:${Math.floor(Number(cursor) / 1000)}` : "";
    const q = `${channel.gmail_query || "in:inbox"}${after}`;
    const res = await fetch(`${API}/messages?q=${encodeURIComponent(q)}&maxResults=50`, {
      headers: { authorization: `Bearer ${access}` },
    });
    const j = (await res.json()) as { messages?: { id: string }[] };
    if (!res.ok) throw new Error(`gmail: list failed (${res.status})`);
    return (j.messages ?? []).map((m) => m.id);
  }

  async fetchMessage(
    channel: { id: string; token_encrypted: string; workspace_id: string },
    id: string
  ): Promise<NormalizedEmail> {
    const access = decryptTokens(channel.token_encrypted).access_token;
    const res = await fetch(`${API}/messages/${id}?format=full`, {
      headers: { authorization: `Bearer ${access}` },
    });
    const j = (await res.json()) as GmailMessage;
    if (!res.ok) throw new Error(`gmail: fetch failed (${res.status})`);
    return this.parseMessage(j);
  }

  parseMessage(msg: GmailMessage): NormalizedEmail {
    const headers = Object.fromEntries(
      (msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );
    const from = headers["from"] ?? "";
    // "Name" <addr> | Name <addr> | bare addr. Angle-bracket form carries the display name; a bare
    // address has no name (greedy name-capture would otherwise eat into the local-part).
    const angle = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+@[^<>]+)>\s*$/);
    const fromEmail = (angle?.[2] ?? from).trim();
    const fromName = angle?.[1]?.trim() || undefined;
    const { plain, html } = extractBodies(msg.payload);
    return {
      messageId: headers["message-id"] ?? msg.id,
      threadId: msg.threadId,
      fromEmail,
      fromName,
      subject: headers["subject"] ?? "",
      text: this.bodyToText(plain, html),
      internalDate: Number(msg.internalDate ?? Date.now()),
    };
  }
}
