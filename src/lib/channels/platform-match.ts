/**
 * Whether `channel` is an eligible publish target for an editorial post authored for `postPlatform`.
 *
 * Channel-model reconciliation (UNIFY1): the replies-wing model stores Facebook and Instagram as DISTINCT
 * channel platforms (the managed connection mints `facebook` and `instagram` rows separately), so a
 * channel matches its editorial platform by an EXACT platform comparison — no `meta`+subKind routing
 * (that was the publishing-wing's single-`meta`-channel model, unused here). The only name difference is
 * editorial `x` ↔ the channel platform `twitter`. Single source of truth shared by the brand target
 * resolver and the publish guard (PSA44) so the two can't drift.
 */
export function channelMatchesPlatform(
  postPlatform: string,
  channel: { platform: string; metadata?: unknown },
): boolean {
  const p = postPlatform.trim().toLowerCase();
  const expected = p === "x" ? "twitter" : p;
  return channel.platform === expected;
}
