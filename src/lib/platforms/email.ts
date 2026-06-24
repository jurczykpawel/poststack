import { convert } from "html-to-text";
import { SocialProvider } from "@/lib/platforms/base";

export interface NormalizedEmail {
  messageId: string;
  threadId: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  text: string;
  internalDate: number;
}

export abstract class EmailProvider extends SocialProvider {
  abstract listNewMessages(
    channel: {
      id: string;
      gmail_query: string | null;
      gmail_sync_cursor: string | null;
      token_encrypted: string;
      workspace_id: string;
    },
    cursor: string | null
  ): Promise<string[]>;

  abstract fetchMessage(
    channel: { id: string; token_encrypted: string; workspace_id: string },
    id: string
  ): Promise<NormalizedEmail>;

  canonicalizeAddress(addr: string): string {
    return addr.trim().toLowerCase();
  }

  bodyToText(plain?: string, html?: string): string {
    if (plain && plain.trim()) return plain;
    if (html && html.trim()) return convert(html, { wordwrap: false });
    return "";
  }
}
