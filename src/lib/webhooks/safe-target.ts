import { env } from "@/lib/env";
import type { IpCategory } from "@/lib/net/ip-classify";
import { assertSafeUrl, safeFetch, type Resolver, type Connector } from "@/lib/net/safe-fetch";

/** Categories webhook delivery (alert + outbound) may target. Secure-by-default: public only.
 *  With WEBHOOK_ALLOW_PRIVATE_TARGETS, a self-host operator may also target loopback/private/CGNAT
 *  receivers (e.g. an internal n8n). link_local(=cloud metadata)/unspecified/multicast/unknown are
 *  NEVER included — the safe-fetch core blocks them regardless. */
export function webhookAllow(): ReadonlySet<IpCategory> {
  return env.WEBHOOK_ALLOW_PRIVATE_TARGETS
    ? new Set<IpCategory>(["public", "loopback", "private", "cgnat"])
    : new Set<IpCategory>(["public"]);
}

export const assertSafeWebhookTarget = (url: string, opts: { resolve?: Resolver } = {}) =>
  assertSafeUrl(url, { allow: webhookAllow(), resolve: opts.resolve });

export const safeFetchWebhook = (
  url: string,
  init: RequestInit = {},
  opts: { resolve?: Resolver; connect?: Connector; deadlineMs?: number } = {},
) =>
  safeFetch(url, init, {
    allow: webhookAllow(),
    resolve: opts.resolve,
    connect: opts.connect,
    deadlineMs: opts.deadlineMs,
  });
