/**
 * Classify an Instagram channel's messaging credential shape WITHOUT decrypting the token blob.
 *
 * `messaging_token_expires_at` (the plaintext IG-Login death-clock column, IGML3) is set exactly when
 * the channel carries an Instagram-Login messaging token: a Facebook-Login IG channel never has one;
 * an IG-Login channel (only or augmented) always does. So its presence is a decrypt-free, allocation-
 * free signal for "this IG account receives/sends DMs via Instagram Login (graph.instagram.com, the
 * Standard-Access path)" vs "Facebook page only (IG DM receipt not guaranteed at Standard Access)".
 *
 * This is the single source the channel UI, the reconnect target, and the REST projection all consume,
 * so the IG-Login vs Facebook-only distinction is derived in one place, never re-encoded.
 */
export type MessagingConnection = "instagram_login" | "facebook_only";

export function messagingConnection(input: {
  platform: string;
  messaging_token_expires_at: Date | null;
}): MessagingConnection | null {
  if (input.platform !== "instagram") return null;
  return input.messaging_token_expires_at ? "instagram_login" : "facebook_only";
}
