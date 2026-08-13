/**
 * Meta Graph API live version-probe (VPROBE1).
 *
 * Hits the REAL Graph API on a target version with real tokens and asserts that every response shape
 * our parsers depend on still holds — so before bumping META_API_VERSION you get a deterministic
 * PASS/FAIL table of exactly which endpoint/field changed, instead of finding out in production.
 *
 * This complements the deterministic mock-contract test (meta-api-contract.test.ts, which proves OUR
 * code is internally consistent) — only this probe can tell you whether the LIVE new version broke us.
 *
 * USAGE (creds from Vaultwarden "Black Cat …"):
 *   META_APP_ID=… META_APP_SECRET=… \
 *   META_PROBE_PAGE_TOKEN=<page access token> \
 *   META_PROBE_PAGE_ID=<fb page id> \
 *   META_PROBE_IG_ID=<ig business id> META_PROBE_IG_TOKEN=<Instagram Login token> \
 *   [META_PROBE_IG_USER_ID=<igsid>] [META_PROBE_PSID=<psid w/ open window>] \
 *   [META_PROBE_VERSION=v26.0]            # default = META_API_VERSION from constants
 *   [META_PROBE_WRITE=1]                  # enable the publish→comment→DM→delete cycle (creates real, then deletes)
 *   bun scripts/meta-version-probe.ts
 *
 * Read-only by default (safe). The write cycle publishes a throwaway post + first comment on the page,
 * sends dedicated test DMs, then DELETES the post (cleanup). Exit code 0 = all probed endpoints OK,
 * 1 = at least one FAIL (a field our code reads is missing/changed). Skipped probes never fail the run.
 *
 * The two-account question: the inbound legs (a comment/DM FROM another account → webhook → auto-reply)
 * cannot be driven via API — Meta blocks acting as an arbitrary user toward a business (publish_actions
 * deprecated 2018; no user→page messaging API; no IG comment-as-user API). Those are covered by the
 * webhook-shape fixtures in the contract test + the assisted webhook mode (VPROBE1-D), not here.
 */
import { META_API_VERSION } from "@/lib/platforms/constants";

const VERSION = process.env.META_PROBE_VERSION || META_API_VERSION;
const BASE = `https://graph.facebook.com/${VERSION}`;
const IG_BASE = `https://graph.instagram.com/${VERSION}`;
const PAGE_TOKEN = process.env.META_PROBE_PAGE_TOKEN;
const PAGE_ID = process.env.META_PROBE_PAGE_ID;
const IG_ID = process.env.META_PROBE_IG_ID;
const IG_TOKEN = process.env.META_PROBE_IG_TOKEN;
const IG_USER_ID = process.env.META_PROBE_IG_USER_ID;
const PSID = process.env.META_PROBE_PSID;
const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const WRITE = process.env.META_PROBE_WRITE === "1";
const STRICT = process.env.META_PROBE_STRICT === "1";
const TIMEOUT_MS = 15_000;

type Outcome = "PASS" | "FAIL" | "SKIP";
interface Result {
  name: string;
  outcome: Outcome;
  detail: string;
}
const results: Result[] = [];

/** Redact credentials from provider responses and URLs before they reach CI output. */
function redact(value: string): string {
  let safe = value
    .replace(/access_token=[^&\s]+/g, "access_token=***")
    .replace(/input_token=[^&\s]+/g, "input_token=***");
  for (const secret of [PAGE_TOKEN, IG_TOKEN, APP_SECRET]) {
    if (secret) safe = safe.split(secret).join("***");
  }
  return safe;
}

interface ProbeOptions {
  body?: unknown;
  requireFields?: string[];
  expectArrayPath?: string;
  okStatus?: number;
  accessToken?: string;
  validate?: (json: Record<string, unknown>) => string | undefined;
}

async function call(
  method: string,
  url: string,
  opts: Pick<ProbeOptions, "body" | "accessToken">,
): Promise<{ status: number; json: Record<string, unknown> | null; raw: string }> {
  const init: RequestInit = { method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) };
  const headers = new Headers();
  if (opts.accessToken) headers.set("authorization", `Bearer ${opts.accessToken}`);
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  const res = await fetch(url, init);
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, raw };
}

/** Resolve a dotted path (e.g. "data.is_valid") to a value, or undefined. */
function at(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function skip(name: string, why: string) {
  results.push({
    name,
    outcome: STRICT ? "FAIL" : "SKIP",
    detail: STRICT ? `strict mode requires this probe: ${why}` : why,
  });
}

/**
 * Run one probe: do the request, then assert each required field exists (and, when a checker is given,
 * passes it). Records PASS / FAIL with a precise reason. `expectArrayPath` asserts a field is an array.
 */
async function probe(
  name: string,
  method: string,
  url: string,
  opts: ProbeOptions = {},
): Promise<Record<string, unknown> | null> {
  const okStatus = opts.okStatus ?? 200;
  try {
    const { status, json, raw } = await call(method, url, opts);
    if (status !== okStatus) {
      const err = redact((at(json, "error.message") as string) ?? raw).slice(0, 160);
      results.push({ name, outcome: "FAIL", detail: `HTTP ${status} (${redact(url)}) — ${err}` });
      return null;
    }
    const missing: string[] = [];
    for (const f of opts.requireFields ?? []) {
      if (at(json, f) === undefined) missing.push(f);
    }
    if (opts.expectArrayPath && !Array.isArray(at(json, opts.expectArrayPath))) {
      missing.push(`${opts.expectArrayPath}[] (not an array)`);
    }
    const validationError = json && opts.validate ? opts.validate(json) : undefined;
    if (validationError) missing.push(validationError);
    if (missing.length) {
      results.push({ name, outcome: "FAIL", detail: `missing/changed fields: ${missing.join(", ")}` });
      return json;
    }
    results.push({ name, outcome: "PASS", detail: redact(url) });
    return json;
  } catch (e) {
    results.push({ name, outcome: "FAIL", detail: `request threw: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
}

async function main() {
  console.log(`\nMeta Graph API version-probe → ${VERSION}  (write cycle: ${WRITE ? "ON" : "off"}; strict: ${STRICT ? "ON" : "off"})\n`);

  if (!PAGE_TOKEN || !PAGE_ID) {
    console.log("META_PROBE_PAGE_TOKEN + META_PROBE_PAGE_ID required — nothing to probe.\n");
    process.exit(STRICT ? 1 : 0); // interactive use can skip; release validation must fail closed
  }
  // ── Read-only: token introspection + identity (debug_token, /me, page node) ──
  if (APP_ID && APP_SECRET) {
    await probe("debug_token (getTokenExpiry)", "GET",
      `${BASE}/debug_token?input_token=${encodeURIComponent(PAGE_TOKEN)}`,
      { accessToken: `${APP_ID}|${APP_SECRET}`, requireFields: ["data.is_valid", "data.expires_at"] });
  } else {
    skip("debug_token (getTokenExpiry)", "no META_APP_ID/META_APP_SECRET");
  }
  await probe("GET /me (page identity)", "GET", `${BASE}/me?fields=id,name`, {
    accessToken: PAGE_TOKEN,
    requireFields: ["id", "name"],
    validate: (json) => String(json.id) === PAGE_ID ? undefined : "id does not match META_PROBE_PAGE_ID",
  });
  await probe("GET /{page} node", "GET", `${BASE}/${PAGE_ID}?fields=id,name`, { accessToken: PAGE_TOKEN, requireFields: ["id", "name"] });
  await probe("GET /{page}/subscribed_apps (read)", "GET", `${BASE}/${PAGE_ID}/subscribed_apps`, { accessToken: PAGE_TOKEN, expectArrayPath: "data" });
  await probe("GET /{page}/feed (page posts)", "GET", `${BASE}/${PAGE_ID}/feed?fields=id,message,created_time,permalink_url`, { accessToken: PAGE_TOKEN, expectArrayPath: "data" });

  // ── Read-only: linked Instagram identity via the Facebook Page token ──
  if (IG_ID) {
    await probe("GET /{ig} (linked IG account)", "GET", `${BASE}/${IG_ID}?fields=id,username,profile_picture_url`, {
      accessToken: PAGE_TOKEN,
      requireFields: ["id", "username"],
      validate: (json) => String(json.id) === IG_ID ? undefined : "id does not match META_PROBE_IG_ID",
    });
  } else {
    skip("GET /{ig} (linked IG account)", "no META_PROBE_IG_ID");
  }

  // ── Read-only: Instagram Business Login uses its own host and token ──
  if (IG_TOKEN) {
    await probe("GET IG /me (Instagram Login identity)", "GET", `${IG_BASE}/me?fields=user_id,username,account_type`, {
      accessToken: IG_TOKEN,
      requireFields: ["user_id", "username", "account_type"],
      validate: (json) => !IG_ID || String(json.user_id) === IG_ID ? undefined : "user_id does not match META_PROBE_IG_ID",
    });
    await probe("GET IG /me/conversations", "GET", `${IG_BASE}/me/conversations?platform=instagram&fields=id,updated_time,participants{id,username}&limit=5`, {
      accessToken: IG_TOKEN,
      expectArrayPath: "data",
    });
  } else {
    skip("GET IG /me (Instagram Login identity)", "no META_PROBE_IG_TOKEN");
    skip("GET IG /me/conversations", "no META_PROBE_IG_TOKEN");
  }
  if (IG_TOKEN && IG_USER_ID) {
    await probe("GET IG recipient profile + follow state", "GET", `${IG_BASE}/${IG_USER_ID}?fields=name,username,profile_pic,is_user_follow_business`, {
      accessToken: IG_TOKEN,
      requireFields: ["username", "is_user_follow_business"],
    });
  } else {
    skip("GET IG recipient profile + follow state", !IG_TOKEN ? "no META_PROBE_IG_TOKEN" : "no META_PROBE_IG_USER_ID");
  }

  // ── Write cycle (opt-in): FB publish/comment/cleanup + dedicated FB and IG DMs ──
  if (!WRITE) {
    skip("publish/comment/DM cycles", "META_PROBE_WRITE != 1 (read-only run)");
  } else {
    const posted = await probe("POST /{page}/feed (publish post)", "POST",
      `${BASE}/${PAGE_ID}/feed`, { accessToken: PAGE_TOKEN, body: { message: `VPROBE ${new Date().toISOString()} — auto-test post` }, requireFields: ["id"] });
    const postId = posted?.id as string | undefined;
    if (postId) {
      await probe("POST /{post}/comments (first comment)", "POST", `${BASE}/${postId}/comments`, { accessToken: PAGE_TOKEN, body: { message: "VPROBE first comment 👇" }, requireFields: ["id"] });
      await probe("GET /{post}/comments (read back)", "GET", `${BASE}/${postId}/comments`, { accessToken: PAGE_TOKEN, expectArrayPath: "data" });
      // Cleanup: delete the throwaway post (also removes its comment).
      await probe("DELETE /{post} (cleanup)", "DELETE", `${BASE}/${postId}`, { accessToken: PAGE_TOKEN, requireFields: ["success"] });
    }
    if (PSID) {
      await probe("POST FB /me/messages (send DM, in-window)", "POST", `${BASE}/me/messages`, { accessToken: PAGE_TOKEN, body: { recipient: { id: PSID }, messaging_type: "RESPONSE", message: { text: "VPROBE Facebook DM test" } }, requireFields: ["message_id"] });
    } else {
      skip("POST FB /me/messages (send DM)", "no META_PROBE_PSID (needs a PSID with an open 24h window)");
    }
    if (IG_TOKEN && IG_USER_ID) {
      await probe("POST IG /me/messages (send DM, in-window)", "POST", `${IG_BASE}/me/messages`, { accessToken: IG_TOKEN, body: { recipient: { id: IG_USER_ID }, messaging_type: "RESPONSE", message: { text: "VPROBE Instagram DM test" } }, requireFields: ["message_id"] });
    } else {
      skip("POST IG /me/messages (send DM)", !IG_TOKEN ? "no META_PROBE_IG_TOKEN" : "no META_PROBE_IG_USER_ID (needs an IGSID with an open messaging window)");
    }
  }

  // ── Report ──
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log("ENDPOINT".padEnd(pad), " RESULT  DETAIL");
  for (const r of results) {
    const mark = r.outcome === "PASS" ? "✅ PASS" : r.outcome === "FAIL" ? "❌ FAIL" : "⏭️  SKIP";
    console.log(r.name.padEnd(pad), mark, " ", r.detail);
  }
  const pass = results.filter((r) => r.outcome === "PASS").length;
  const fail = results.filter((r) => r.outcome === "FAIL").length;
  const skipped = results.filter((r) => r.outcome === "SKIP").length;
  console.log(`\n${pass} passed · ${fail} failed · ${skipped} skipped  (target ${VERSION})\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
