# Adding a Mailbox Provider

PostStack is extensible — you can add support for new mailbox providers (Gmail, Outlook, ProtonMail, etc.) by implementing the `EmailProvider` base class.

## Extension Point: EmailProvider

All email providers extend the `EmailProvider` abstract class defined in `src/lib/platforms/email.ts`. The base class handles shared MIME parsing, threading, and plaintext conversion; a new provider only implements the transport layer (API calls to the mailbox service).

### Required Methods

```typescript
export abstract class EmailProvider extends SocialProvider {
  // OAuth flow
  async generateAuthUrl(state: string, redirectUri: string): string | Promise<string>
  async authenticate(code: string, redirectUri: string): Promise<ConnectedAccount[]>
  async refreshToken(tokens: TokenData): Promise<TokenData>

  // Message fetching
  async listNewMessages(
    channel: {
      id: string;
      gmail_query: string | null;      // Provider-specific search filter
      gmail_sync_cursor: string | null; // Pagination cursor
      token_encrypted: string;
      workspace_id: string;
    },
    cursor: string | null
  ): Promise<string[]> // Returns array of message IDs

  async fetchMessage(
    channel: { id: string; token_encrypted: string; workspace_id: string },
    id: string
  ): Promise<NormalizedEmail> // Returns normalized message

  // Sending
  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent,
    opts?: SendMessageOptions
  ): Promise<SentMessage>

  // Helpers (usually implemented in the base, may override)
  canonicalizeAddress(addr: string): string // Normalize email addresses
  bodyToText(plain?: string, html?: string): string // Extract text from MIME
}
```

### NormalizedEmail

Every `fetchMessage()` must return a normalized email:

```typescript
interface NormalizedEmail {
  messageId: string;        // Unique ID (per mailbox)
  threadId: string;         // For threading replies into conversations
  fromEmail: string;        // Sender's email (normalized by canonicalizeAddress)
  fromName?: string;        // Sender's display name (optional)
  subject: string;          // Email subject
  text: string;            // Plaintext body (extracted from MIME by bodyToText)
  internalDate: number;    // Timestamp (milliseconds since epoch)
}
```

## Implementation Steps

### 1. Create the Provider Class

Create `src/lib/platforms/{provider}.ts`:

```typescript
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

export class OutlookProvider extends EmailProvider {
  readonly platform = "outlook" as const satisfies Platform;
  readonly displayName = "Outlook";

  async generateAuthUrl(state: string, redirectUri: string): Promise<string> {
    // Return OAuth authorization URL
  }

  async authenticate(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    // Exchange code for tokens, fetch user profile
    // Return array of connected accounts (typically one for email)
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    // Refresh expired access token
  }

  async listNewMessages(
    channel: { id: string; gmail_query: string | null; gmail_sync_cursor: string | null; token_encrypted: string; workspace_id: string },
    cursor: string | null
  ): Promise<string[]> {
    const tokens = decryptTokens(channel.token_encrypted);
    // Query the provider's API for new message IDs since cursor
    // gmail_query contains the ingest filter (e.g. "is:unread" for Outlook)
  }

  async fetchMessage(
    channel: { id: string; token_encrypted: string; workspace_id: string },
    id: string
  ): Promise<NormalizedEmail> {
    const tokens = decryptTokens(channel.token_encrypted);
    // Fetch the full message, normalize MIME, extract text
  }

  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent,
    opts?: SendMessageOptions
  ): Promise<SentMessage> {
    // Send an email reply using the provider's API
    // opts.email contains threadId, inReplyTo, and subject for threading
  }
}
```

### 2. Register the Provider

Add it to `src/lib/platforms/registry.ts`:

```typescript
import { OutlookProvider } from "./outlook";

// In the auto-register block at the bottom:
registerProvider("outlook", () => new OutlookProvider());
```

### 3. Add the Platform to the Schema

Update `src/db/schema.ts`:

```typescript
export const platform = pgEnum("platform", [
  // ... existing platforms ...
  "outlook",  // Add your new platform
]);
```

### 4. Create a Database Migration

Run `npx drizzle-kit generate` to auto-generate the SQL. The migration will add the new enum value.

### 5. Register with the Email Poller

Update `src/lib/email/poll.ts`:

```typescript
const EMAIL_PLATFORMS: Platform[] = ["gmail", "outlook"];
```

This tells the poller which platforms to process in the email-channel polling loop.

### 6. Add OAuth Callback Route

Create `src/server/handlers/oauth/outlook/route.ts` following the pattern of the Gmail callback:

```typescript
import { Hono } from "hono";
import { OutlookProvider } from "@/lib/platforms/outlook";
// ... handle OAuth callback, validate state, call authenticate, store tokens
```

## Key Patterns

### Token Storage

- **Encrypt at rest:** Always call `encryptTokens()` before writing to the database.
- **Decrypt on use:** Call `decryptTokens()` before passing to API calls.
- The same `ENCRYPTION_KEY` is used for all providers.

### Pagination & Cursors

- `listNewMessages()` is called once per polling cycle (default 5 min interval).
- The `cursor` parameter is the last-seen internal date or max message id.
- Return the new message IDs; the polling worker fetches each and updates the cursor after a successful batch.

### Email Threading

- Gmail uses `threadId` to group related messages.
- When sending a reply, pass `opts.email.threadId` to the `sendMessage()` call.
- The provider should set RFC 822 headers (`In-Reply-To`, `References`) to properly thread the outgoing message in the recipient's mailbox.

### Scopes & Permissions

- **Gmail scopes** (read-only ingest + send):
  - `openid` — basic identity
  - `email` — email address
  - `https://www.googleapis.com/auth/gmail.readonly` — read messages
  - `https://www.googleapis.com/auth/gmail.send` — send messages

- **Outlook scopes** (example):
  - `Mail.Read` — read messages
  - `Mail.Send` — send messages
  - `User.Read` — user profile

## Restricted Scopes & Verification

Both Gmail and Outlook have **restricted scopes** that require **Google/Microsoft OAuth app verification**:

- **Unverified apps** can only authorize the developer's own account + ~100 test users.
- **To serve arbitrary mailboxes** (real multi-tenant SaaS), the app must pass OAuth app verification and (for Gmail) a **CASA security assessment** (annual fee, ~$200).

For **self-hosting your own or your team's mailbox**, add yourself as a test user — no verification needed.

## Testing

1. **Locally:** Set up `.env` with test OAuth credentials, then manually connect a channel in the dashboard.
2. **Integration tests:** Add tests in `src/lib/platforms/*.test.ts` following the existing Gmail tests.
3. **E2E:** Connect the channel to a test instance and verify incoming messages are ingested and outgoing replies send successfully.

## Reference

- Gmail provider: `src/lib/platforms/gmail.ts`
- Email base: `src/lib/platforms/email.ts`
- Email poller: `src/lib/email/poll.ts`
- OAuth flow: `src/lib/platforms/google-oauth.ts`
