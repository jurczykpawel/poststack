// Capture a contact's email/phone from the free-text reply a user sends after a Meta
// `user_email` / `user_phone_number` quick reply. Meta does not tag that response, so the
// arming flag (conversations.awaiting_capture) tells the inbound worker which field to expect;
// these extractors validate the text before it is written to the contact.

// Pragmatic email match — good enough to pull the address out of "sure, it's a@b.com thanks".
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Extract a normalized (trimmed, lowercased) email, or null when the text holds none. */
export function extractEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(EMAIL_RE);
  return match ? match[0].trim().toLowerCase() : null;
}

/**
 * Extract a phone number, keeping a leading `+` and digits only. Returns null for anything
 * shorter than a plausible national number (8 digits) so "12345" or prose can't be captured.
 */
export function extractPhone(text: string | null | undefined): string | null {
  if (!text) return null;
  const plus = text.trim().startsWith("+");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 8) return null;
  return plus ? `+${digits}` : digits;
}

/** The two fields a conversation can be armed to capture. Mirrors the `capture_field` enum. */
export type CaptureField = "email" | "phone";

/** Validate raw reply text for the armed field; null = nothing usable to store. */
export function extractCaptured(field: CaptureField, text: string | null | undefined): string | null {
  return field === "email" ? extractEmail(text) : extractPhone(text);
}

/**
 * Which field (if any) an outgoing message arms for capture: a `user_email` / `user_phone_number`
 * quick reply pre-fills the user's address from their Meta profile, so the next inbound message is
 * their email/phone. Returns the first such field found, or null when the message arms nothing.
 */
export function captureFieldFromQuickReplies(
  quickReplies?: { content_type?: "text" | "user_email" | "user_phone_number" }[],
): CaptureField | null {
  for (const qr of quickReplies ?? []) {
    if (qr.content_type === "user_email") return "email";
    if (qr.content_type === "user_phone_number") return "phone";
  }
  return null;
}
