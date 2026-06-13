import { PermanentError } from "./errors";

/**
 * PSA50: guard a URL taken from a platform's response body/headers (upload_url, resumable Location,
 * paging.next) before we follow it — often with the OAuth token attached. Require https and a host
 * that suffix-matches one of the platform's known domains, so a hostile or MITM'd platform response
 * can't redirect the request (and its token) to an internal address or an attacker host.
 */
export function assertAllowedHost(rawUrl: string, allowedHosts: string[]): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new PermanentError("refusing to follow a malformed response URL");
  }
  if (u.protocol !== "https:") {
    throw new PermanentError(`refusing to follow a non-https response URL: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new PermanentError(`refusing to follow a response URL to an unexpected host: ${host}`);
  }
}
