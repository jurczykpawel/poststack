export type ProviderErrorKind = "token_invalid" | "transient" | "permanent" | "rate_limited";

/**
 * PSA36 — where in a multi-step publish a transient/rate-limited error happened:
 *  - `pre_commit`: before any irreversible platform mutation (container-create, resumable init,
 *    media download, upload to a not-yet-published container) → the worker can safely re-run the
 *    whole publish; nothing public was created.
 *  - `commit_uncertain`: the failing step may have landed (the final publish/finalize call, or a
 *    single-shot provider) → the worker must NOT re-run it (would duplicate the public post, PSA2).
 * Default `commit_uncertain` everywhere — tagging `pre_commit` is an explicit, per-step opt-in.
 */
export type PublishPhase = "pre_commit" | "commit_uncertain";

export abstract class ProviderError extends Error {
  abstract readonly kind: ProviderErrorKind;
}

/** Token is dead — refreshing/retrying won't help; the channel needs reconnect. */
export class TokenInvalidError extends ProviderError {
  readonly kind = "token_invalid" as const;
}

/** Temporary failure (5xx, network) — safe to retry with backoff. */
export class TransientError extends ProviderError {
  readonly kind = "transient" as const;
  constructor(
    message: string,
    public readonly phase: PublishPhase = "commit_uncertain",
  ) {
    super(message);
  }
}

/** Permanent failure (bad request/content) — do not retry. */
export class PermanentError extends ProviderError {
  readonly kind = "permanent" as const;
}

/** Rate limited — retry after the platform-suggested delay. */
export class RateLimitedError extends ProviderError {
  readonly kind = "rate_limited" as const;
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
    public readonly phase: PublishPhase = "commit_uncertain",
  ) {
    super(message);
  }
}
