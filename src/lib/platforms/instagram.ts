import { SocialProvider, type TokenData, type ConnectedAccount, type MessageContent, type SentMessage } from "./base";

export class InstagramProvider extends SocialProvider {
  readonly platform = "instagram" as const;
  readonly displayName = "Instagram";

  generateAuthUrl(_state: string, _redirectUri: string): string {
    throw new Error("InstagramProvider not yet implemented — Phase 2");
  }

  async authenticate(_code: string, _redirectUri: string): Promise<ConnectedAccount[]> {
    throw new Error("InstagramProvider not yet implemented — Phase 2");
  }

  async refreshToken(_tokens: TokenData): Promise<TokenData> {
    throw new Error("InstagramProvider not yet implemented — Phase 2");
  }

  async sendMessage(_tokens: TokenData, _recipientId: string, _content: MessageContent): Promise<SentMessage> {
    throw new Error("InstagramProvider not yet implemented — Phase 2");
  }

  async sendComment(_tokens: TokenData, _objectId: string, _message: string): Promise<void> {
    throw new Error("InstagramProvider not yet implemented — Phase 2");
  }

  requiresTokenRefresh(): boolean {
    return true; // Instagram tokens expire every 60 days
  }

  refreshBufferSeconds(): number {
    return 10 * 24 * 60 * 60; // Refresh 10 days before expiry
  }
}
