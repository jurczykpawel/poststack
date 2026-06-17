/**
 * Meta inbound-trigger live e2e — assisted mode (VPROBE1-D).
 *
 * The one leg the pure version-probe (meta-version-probe.ts) cannot drive: a comment FROM another
 * account → Meta webhook → our rule engine → auto-reply DM. Meta blocks acting as an arbitrary user
 * via API (publish_actions deprecated; no user→page messaging; no IG comment-as-user), so this needs
 * ONE human action — but everything around it is automated and the verdict is deterministic.
 *
 * What it does:
 *   1. (optional) publishes a throwaway post on the page via Graph,
 *   2. creates a comment-keyword → DM auto-reply rule scoped to that post (via the instance API),
 *   3. prints "comment '<keyword>' on <url> from another account", then POLLS the live instance's
 *      API until it sees the inbound comment AND an outbound reply fired by our rule (or times out),
 *   4. cleans up: deletes the rule and (if it published) the post.
 *
 * Deterministic PASS/FAIL: PASS only if the full pipeline produced an outbound rule-driven reply.
 *
 * USAGE:
 *   PROBE_API_BASE=https://poststack.techskills.academy \
 *   PROBE_API_KEY=rs_live_… \                       # API key for the workspace owning the page
 *   PROBE_KEYWORD=KOT [PROBE_REPLY_TEXT="…"] [PROBE_TIMEOUT_S=180] \
 *   # auto-publish (else set PROBE_POST_ID + PROBE_PERMALINK):
 *   META_PROBE_PAGE_TOKEN=… META_PROBE_PAGE_ID=… [META_PROBE_VERSION=v25.0] \
 *   [PROBE_CHANNEL_ID=<instance channel uuid for that page>] \
 *   bun scripts/meta-webhook-e2e.ts
 *
 * Env-gated: without PROBE_API_BASE + PROBE_API_KEY it skips (exit 0). Exit 1 on FAIL/timeout.
 */
import { META_API_VERSION } from "@/lib/platforms/constants";

const API_BASE = process.env.PROBE_API_BASE?.replace(/\/$/, "");
const API_KEY = process.env.PROBE_API_KEY;
const KEYWORD = process.env.PROBE_KEYWORD || "KOT";
const REPLY_TEXT = process.env.PROBE_REPLY_TEXT || `VPROBE auto-reply ✅ (${KEYWORD})`;
const TIMEOUT_S = Number(process.env.PROBE_TIMEOUT_S || 180);
const POLL_S = Number(process.env.PROBE_POLL_S || 5);
const CHANNEL_ID = process.env.PROBE_CHANNEL_ID;
const VERSION = process.env.META_PROBE_VERSION || META_API_VERSION;
const PAGE_TOKEN = process.env.META_PROBE_PAGE_TOKEN;
const PAGE_ID = process.env.META_PROBE_PAGE_ID;
let POST_ID = process.env.PROBE_POST_ID;
let PERMALINK = process.env.PROBE_PERMALINK;

const GRAPH = `https://graph.facebook.com/${VERSION}`;
const TIMEOUT_MS = 15_000;

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: T | null = null;
  try { json = JSON.parse(text) as T; } catch { /* non-json */ }
  return { status: res.status, json };
}

async function graph(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  try { return (await res.json()) as Record<string, unknown>; } catch { return null; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { id: string; direction: string; text: string | null; sent_by_rule_id: string | null; created_at: string }
interface Conv { id: string }

async function main() {
  if (!API_BASE || !API_KEY) {
    console.log("PROBE_API_BASE + PROBE_API_KEY required — skipping (env-gated).");
    process.exit(0);
  }
  console.log(`\nMeta inbound-trigger e2e (assisted) → ${API_BASE}  keyword="${KEYWORD}"\n`);

  let createdPost = false;
  let ruleId: string | undefined;
  let ok = false;

  try {
    // 1. Publish a throwaway post (optional).
    if (!POST_ID) {
      if (!PAGE_TOKEN || !PAGE_ID) {
        console.error("No PROBE_POST_ID and no META_PROBE_PAGE_TOKEN/META_PROBE_PAGE_ID to publish one. Aborting.");
        process.exit(1);
      }
      const posted = await graph("POST", `${GRAPH}/${PAGE_ID}/feed`, { message: `VPROBE webhook e2e — comment "${KEYWORD}" below 👇`, access_token: PAGE_TOKEN });
      POST_ID = posted?.id as string | undefined;
      if (!POST_ID) { console.error("Publish failed:", posted); process.exit(1); }
      createdPost = true;
      PERMALINK = `https://www.facebook.com/${POST_ID}`;
      console.log(`📝 Published test post ${POST_ID}`);
    }

    // 2. Create the comment-keyword → DM rule scoped to that post.
    const rule = await api<{ data?: { id: string } }>("POST", "/api/v1/rules", {
      name: `VPROBE webhook e2e ${new Date().toISOString()}`,
      ...(CHANNEL_ID ? { channel_id: CHANNEL_ID } : {}),
      trigger_type: "comment_keyword",
      trigger_config: { keywords: [{ value: KEYWORD, match_type: "contains" }], post_id: POST_ID },
      response_type: "text",
      response_config: { text: REPLY_TEXT, reply_mode: "dm" },
    });
    if (rule.status !== 201 || !rule.json?.data?.id) { console.error("Rule create failed:", rule.status, rule.json); process.exit(1); }
    ruleId = rule.json.data.id;
    console.log(`🤖 Created auto-reply rule ${ruleId} (comment "${KEYWORD}" → DM)\n`);

    // 3. Prompt + poll.
    const cutoff = Date.now();
    console.log("─".repeat(60));
    console.log(`👉 NOW comment "${KEYWORD}" under the post FROM ANOTHER ACCOUNT (not the page):`);
    console.log(`   ${PERMALINK}`);
    console.log(`   Waiting up to ${TIMEOUT_S}s for the webhook → rule → reply…`);
    console.log("─".repeat(60));

    let sawComment = false;
    const deadline = Date.now() + TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      await sleep(POLL_S * 1000);
      const convs = await api<{ data?: Conv[] }>("GET", "/api/v1/conversations?limit=25");
      for (const c of convs.json?.data ?? []) {
        const msgs = await api<{ data?: Msg[] }>("GET", `/api/v1/conversations/${c.id}/messages?limit=25`);
        for (const m of msgs.json?.data ?? []) {
          if (new Date(m.created_at).getTime() < cutoff) continue;
          if (m.direction === "in" && (m.text ?? "").toLowerCase().includes(KEYWORD.toLowerCase()) && !sawComment) {
            sawComment = true;
            console.log(`✅ inbound comment received ("${m.text}")`);
          }
          if (m.direction === "out" && m.sent_by_rule_id === ruleId) {
            console.log(`✅ auto-reply fired ("${m.text}") — full webhook→rule→reply pipeline OK`);
            ok = true;
          }
        }
      }
      if (ok) break;
      process.stdout.write(".");
    }
    console.log("");
    if (!ok) console.log(`❌ Timed out after ${TIMEOUT_S}s — comment-received=${sawComment}, auto-reply=false`);
  } finally {
    // 4. Cleanup.
    if (ruleId) { await api("DELETE", `/api/v1/rules/${ruleId}`); console.log(`🧹 deleted rule ${ruleId}`); }
    if (createdPost && POST_ID && PAGE_TOKEN) { await graph("DELETE", `${GRAPH}/${POST_ID}?access_token=${encodeURIComponent(PAGE_TOKEN)}`); console.log(`🧹 deleted post ${POST_ID}`); }
  }

  console.log(`\n${ok ? "PASS ✅" : "FAIL ❌"} — inbound-trigger e2e\n`);
  process.exit(ok ? 0 : 1);
}

main();
