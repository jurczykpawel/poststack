import { vi } from "vitest";

export interface RecordedExchange {
  method: string;
  url: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const key = (method: string, url: string) => {
  const u = new URL(url);
  // The Graph version is not part of the contract being replayed; query strings carry tokens/params.
  return `${method} ${u.host}${u.pathname.replace(/^\/v\d+\.\d+\//, "/")}`;
};

/**
 * Stub global fetch with recorded responses. Each request consumes the first unused exchange with the
 * same method + host + path (Graph version and query ignored). Requests to `extra` hosts get the
 * supplied handler (media bytes, upload PUTs that were not recorded). Anything else fails the test.
 */
export function replayFetch(exchanges: RecordedExchange[], extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const queue = exchanges.map((e) => ({ ...e, used: false }));
  const calls: { method: string; url: string; body: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "" });
    const fallback = extra(url, init);
    if (fallback) return fallback;
    const hit = queue.find((e) => !e.used && key(e.method, e.url) === key(method, url));
    if (!hit) throw new Error(`no recorded exchange for ${method} ${url}`);
    hit.used = true;
    const body = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return new Response(hit.status === 204 ? null : body, { status: hit.status, headers: { "content-type": "application/json", ...hit.headers } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, unused: () => queue.filter((e) => !e.used) };
}

/** `<page>_<post>` → page id; the page a recording was made on. */
export const pageOf = (url: string) => /\/v\d+\.\d+\/(\d+)\//.exec(url)?.[1] ?? "";
