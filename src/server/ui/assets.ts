import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, normalize } from "node:path";

const ROOT = join(process.cwd(), "src/server/ui/static");

// Content-hash cache-buster. Static assets are cached hard (Cloudflare/browser) and the
// <link>/<script> URLs are unversioned — so a CSS/JS change stays invisible until a manual refresh.
// Appending ?v=<hash> changes the URL whenever the file content changes → fresh fetch through any proxy.
const versionCache = new Map<string, string>();
export function assetUrl(rel: string): string {
  let v = versionCache.get(rel);
  if (v === undefined) {
    try {
      v = createHash("sha1").update(readFileSync(join(ROOT, rel))).digest("hex").slice(0, 10);
    } catch {
      v = "";
    }
    versionCache.set(rel, v);
  }
  return v ? `/static/${rel}?v=${v}` : `/static/${rel}`;
}
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serve a file from ui/static. `rel` is everything after `/static/`. */
export async function serveAsset(c: Context, rel: string): Promise<Response> {
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!/^[\w./-]+$/.test(safe) || safe.includes("..")) return c.notFound();
  const dot = safe.lastIndexOf(".");
  const ext = dot !== -1 ? safe.slice(dot) : "";
  const type = MIME[ext];
  if (!type) return c.notFound();
  try {
    const body = await readFile(join(ROOT, safe));
    const cache = safe.startsWith("vendor/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate";
    return c.body(body, 200, { "content-type": type, "cache-control": cache });
  } catch {
    return c.notFound();
  }
}
