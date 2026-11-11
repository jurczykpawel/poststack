import { pathToFileURL } from "node:url";
import { resolvePublishTarget, telegramProvider } from "../../src/lib/providers/telegram";

type Env = Partial<Record<"LIVE_TG_BOT_TOKEN" | "LIVE_TG_CHAT_ID" | "GITHUB_SHA", string>>;

export async function runSmoke(env: Env, pause = () => new Promise<void>(resolve => setTimeout(resolve, 1100))): Promise<void> {
  const { LIVE_TG_BOT_TOKEN: token, LIVE_TG_CHAT_ID: chatId, GITHUB_SHA: sha } = env;
  if (!token || !chatId) throw new Error("LIVE_TG_BOT_TOKEN and LIVE_TG_CHAT_ID are required");
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("GITHUB_SHA must identify the fixture commit");
  const target = await resolvePublishTarget(token, chatId);
  // Immutable URLs exercise the provider's normal pull_url path, including release candidates.
  const base = `https://raw.githubusercontent.com/jurczykpawel/poststack/${sha}/tests/fixtures/live/telegram`;
  const ids = new Set<string>();
  try {
    for (const [format, mediaUrls, mediaKinds] of [
      ["text", [], []], ["image", [`${base}.jpg`], ["image"]],
      ["video", [`${base}.mp4`], ["video"]],
      ["carousel", [`${base}.jpg`, `${base}.mp4`], ["image", "video"]],
    ] as const) {
      if (ids.size) await pause();
      const handle = await telegramProvider.publish({
        tokens: { accessToken: token }, accountId: target, channelMetadata: { publishTarget: target },
        request: { format, caption: `PostStack Telegram smoke ${sha.slice(0, 12)}: ${format}`, media: [] },
        mediaUrls: [...mediaUrls], mediaKinds: [...mediaKinds],
      });
      const current = handle.providerHandle.split(",");
      for (const id of current) if (/^[1-9]\d*$/.test(id)) ids.add(id);
      if (current.length !== (format === "carousel" ? 2 : 1) || current.some(id => !/^[1-9]\d*$/.test(id)) || new Set(current).size !== current.length) {
        throw new Error(`Invalid message_id for ${format}`);
      }
    }
  } finally {
    await cleanup();
  }
  async function cleanup() {
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: target, message_id: id }),
          redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        const body = await res.json() as { ok?: boolean; result?: boolean };
        if (!res.ok || body.ok !== true || body.result !== true) throw new Error("Deletion not acknowledged");
      } catch { failed.push(id); }
    }
    if (failed.length) throw new Error(`Cleanup failed for message_id: ${failed.join(",")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke(process.env).then(() => console.log("Telegram smoke passed; all five messages deleted")).catch((error: unknown) => {
    // Provider errors may contain external descriptions; keep console output predictable.
    const message = error instanceof Error && /^(LIVE_TG_|GITHUB_SHA|Cleanup failed)/.test(error.message)
      ? error.message : "Telegram smoke failed; inspect the test channel. No automatic publish retry.";
    console.error(message);
    process.exitCode = 1;
  });
}
