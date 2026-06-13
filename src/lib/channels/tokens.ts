import { decryptTokens, type TokenData } from "@/lib/crypto";
import { TokenInvalidError } from "@/lib/platforms/errors";

/**
 * Decrypt a channel's stored OAuth token for a send/refresh path, mapping a decrypt FAILURE to
 * a re-auth case.
 *
 * `decryptTokens` throws a generic Error when the ciphertext can't be authenticated — a corrupt
 * `token_encrypted` (partial write / bad restore) or a rotated `ENCRYPTION_KEY` without a
 * re-encrypt (a documented DR step). On the worker send/refresh paths a generic throw lands in
 * the delivery state machine's "transient" branch and crash-loops to the dead-letter queue WITHOUT
 * ever flagging the channel `needs_reauth` — a silent total outbound outage with no operator signal
 *. Re-throwing as {@link TokenInvalidError} makes the existing breaker handle it: the
 * delivery is parked `held`, the channel is flagged `needs_reauth`, and the down-alert fires.
 *
 * Use this everywhere a worker decrypts to send/refresh. Read-only callers that surface their own
 * clean failure (e.g. the posts picker returns a 400, the refresh SCAN skips and continues) keep
 * calling `decryptTokens` directly.
 */
export function decryptChannelToken(encrypted: string): TokenData {
  try {
    return decryptTokens(encrypted);
  } catch {
    throw new TokenInvalidError("Channel token cannot be decrypted — reconnect the channel");
  }
}
