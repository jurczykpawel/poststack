import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Env = Partial<Record<"TEST_BASE_URL" | "LIVE_X_API_KEY" | "LIVE_X_CHANNEL_ID", string>>;
type Data = { id?: string; publishedUrl?: string; delivery?: { id: string; status: string; platformPostId?: string }; exists?: boolean; providerStatus?: number; platformPostId?: string; deleted?: boolean };
export async function runSmoke(env: Env, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch, timeoutMs = 180_000, report: (text: string) => void = () => {}): Promise<string> {
  const { TEST_BASE_URL: base, LIVE_X_API_KEY: key, LIVE_X_CHANNEL_ID: channelId } = env;
  if (!base || !key || !channelId) return "⚠️ not configured: TEST_BASE_URL, LIVE_X_API_KEY and LIVE_X_CHANNEL_ID are required";
  const target = new URL(base);
  if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("TEST_BASE_URL must be an HTTPS origin");
  async function api(path: string, method = "GET", body?: unknown): Promise<Data> {
    const res = await fetcher(`${target.origin}/api/v1${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      report(`PostStack HTTP ${res.status} (${method} ${path})`);
      throw new Error(`PostStack HTTP ${res.status} (${method} ${path})`);
    }
    if (res.status === 204) return {};
    const json = await res.json() as { data: Data; error?: unknown };
    if (json.error || !json.data) throw new Error("Invalid PostStack response");
    return json.data;
  }
  const post = await api("/posts", "POST", { platform: "twitter", description: `PostStack live X smoke ${new Date().toISOString()}`, firstComment: "", autoStory: false, aiDisclosure: "none", aiDisclosureNote: "" });
  if (!post.id) throw new Error("Missing post ID");
  const path = `/posts/${encodeURIComponent(post.id)}`;
  let sent = false;
  report(`Created TEST post: ${encodeURIComponent(post.id)}`);
  let link: string;
  try {
    await api(`${path}/publish`, "POST", { channelId, when: "now", format: "text" });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await api(path);
      const d = current.delivery;
      if (d?.status === "sent") {
        sent = true;
        link = current.publishedUrl ?? "";
        if (!d.platformPostId || !/^\d+$/.test(d.platformPostId) || !new RegExp(`^https://x\\.com/(?:i/web|[A-Za-z0-9_]+)/status/${d.platformPostId}$`).test(link)) throw new Error("Invalid sent ID/URL");
        const read = await api(`${path}/platform`);
        if (!read.exists || read.platformPostId !== d.platformPostId) throw new Error("Platform read failed");
        break;
      }
      if (d && ["failed", "held", "unknown"].includes(d.status)) throw new Error(`Delivery ${d.status}; inspect post ${post.id} on TEST`);
      if (Date.now() >= deadline) throw new Error(`delivery timeout; inspect post ${post.id} on TEST`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } finally {
    await cleanup();
  }
  async function cleanup() {
    if (!sent) {
      const current = await api(path);
      sent = current.delivery?.status === "sent";
      if (!sent && current.delivery) await api(`/deliveries/${encodeURIComponent(current.delivery.id)}/cancel`, "POST");
    }
    if (sent) {
      report(`Cleanup TEST post: ${encodeURIComponent(post.id!)}`);
      const deleted = await api(`${path}/platform`, "DELETE");
      if (!deleted.deleted) throw new Error(`Deletion not acknowledged: ${post.id}`);
      const check = await api(`${path}/platform`);
      if (check.exists !== false || check.providerStatus !== 404) throw new Error(`Deletion not confirmed: ${post.id}`);
    }
  }
  return `✅ PASS: sent, read, deleted and confirmed X 404. ${link} (post ${post.id}). Estimated cost ~ $0.02.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = (message: string) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  };
  runSmoke(process.env, fetch, 180_000, report).then((result) => {
    console.log(result);
    if (result.includes("not configured")) console.log("::warning::Live X not configured; no requests made");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result}\n`);
  }).catch(() => {
    const message = "❌ Live X smoke failed. Inspect the run's test post/delivery on TEST; cleanup may require manual action. No automatic publish retry.";
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    process.exitCode = 1;
  });
}
