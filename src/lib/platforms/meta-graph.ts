import { GRAPH_API_BASE } from "./constants";
import { MetaTokenError } from "./meta-token";

// The Meta Graph hosts we will follow a response-supplied paging URL to. A `paging.next` URL comes
// from Meta's response body and carries our token in its query string — so before following it we
// require https + a Meta host (PSA50), or a hostile/MITM'd response could exfiltrate the token.
const META_GRAPH_HOSTS = ["facebook.com", "fbcdn.net"];

/** PSA50: guard a response-supplied Graph paging URL before we follow it (token rides in the query). */
export function assertMetaGraphHost(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new MetaTokenError("Refusing to follow a malformed Graph paging URL.");
  }
  if (u.protocol !== "https:") {
    throw new MetaTokenError("Refusing to follow a non-HTTPS Graph paging URL.");
  }
  const host = u.hostname.toLowerCase();
  if (!META_GRAPH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new MetaTokenError("Refusing to follow a Graph paging URL to an unexpected host.");
  }
}

interface GraphPage<T> {
  data?: T[];
  paging?: { next?: string };
}

/**
 * Enumerate EVERY row of the `me/accounts` edge for a user/System-User token, following `paging.next`
 * (PSA50 host-guarded, capped at 20 pages). A managed connection can manage far more Pages than fit in
 * one response page; without pagination the Pages/IG accounts past the first ~25 are silently dropped.
 */
export async function fetchAllManagedPages<T>(userToken: string, fields: string): Promise<T[]> {
  let next: string | undefined =
    `${GRAPH_API_BASE}/me/accounts?` +
    new URLSearchParams({ access_token: userToken, fields, limit: "100" }).toString();
  const rows: T[] = [];
  for (let guard = 0; next && guard < 20; guard++) {
    if (guard > 0) assertMetaGraphHost(next); // first URL is ours; later ones come from the response
    const res = await fetch(next, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch Facebook pages: ${body}`);
    }
    const json = (await res.json().catch(() => ({}))) as GraphPage<T>;
    if (Array.isArray(json.data)) rows.push(...json.data);
    next = json.paging?.next;
  }
  return rows;
}
