import { SocialProvider, type TokenData, type ConnectedAccount, type MessageContent, type SentMessage } from "./base";

export class FacebookProvider extends SocialProvider {
  readonly platform = "facebook" as const;
  readonly displayName = "Facebook";

  generateAuthUrl(_state: string, _redirectUri: string): string {
    throw new Error("FacebookProvider not yet implemented — Phase 2");
  }

  async authenticate(_code: string, _redirectUri: string): Promise<ConnectedAccount[]> {
    throw new Error("FacebookProvider not yet implemented — Phase 2");
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    return tokens; // Facebook page tokens don't expire
  }

  async sendMessage(_tokens: TokenData, _recipientId: string, _content: MessageContent): Promise<SentMessage> {
    throw new Error("FacebookProvider not yet implemented — Phase 2");
  }

  async sendComment(_tokens: TokenData, _objectId: string, _message: string): Promise<void> {
    throw new Error("FacebookProvider not yet implemented — Phase 2");
  }

  requiresTokenRefresh(): boolean {
    return false;
  }
}
