import { z } from "zod";
import type { Hono, MiddlewareHandler } from "hono";
import { html, raw } from "hono/html";
import { authenticateSession } from "@/lib/auth";
import { ApiError } from "@/lib/api/response";
import { getQueueItem } from "./queue-data";
import { getTikTokCreatorInfo } from "@/lib/channels/tiktok-creator-info";
import { confirmTikTokDelivery } from "@/lib/deliveries/tiktok-confirmation";
import { getMedia } from "@/lib/media/service";
import type { PublishRequest } from "@/lib/providers/types";
import { renderPage } from "../layout";
import { tiktokPanel, tiktokPanelScript } from "../components/tiktok-panel";
import { safeHttpUrl } from "../components/url";
import { assetUrl } from "../assets";

const deliveryIdSchema = z.string().uuid();

export function registerTikTokConfirmation(r: Hono, guard: MiddlewareHandler) {
  r.get("/queue/:id/confirm", guard, async (c) => {
    const a = await authenticateSession(c.req.raw).catch(() => null);
    if (!a) return c.redirect("/login");
    if (!deliveryIdSchema.safeParse(c.req.param("id")).success) return c.text("Not found", 404);
    const item = await getQueueItem(a.workspaceId, c.req.param("id"));
    if (!item || item.channel.platform !== "tiktok") return c.text("Not found", 404);
    if (item.post.status !== "held" || item.post.tiktok_confirmation !== "required") return c.redirect(`/queue/${item.post.id}`);
    const creator = await getTikTokCreatorInfo(a.workspaceId, item.channel.id, { refresh: true }).catch(() => null);
    const request = item.post.payload as PublishRequest;
    const media = request.media[0] ? await getMedia(request.media[0].mediaId, a.workspaceId).catch(() => null) : null;
    const data = { creator, channelId: item.channel.id, mode: request.options?.publishMode === "direct" ? "direct" : "inbox", caption: request.caption ?? "", mediaUrl: safeHttpUrl(media?.url ?? "") ?? "", duration: media?.duration_sec ?? 0 };
    return c.html(renderPage({ title: "Confirm TikTok submission", nav: "queue", body: html`
      <p class="notice notice-warn">${item.post.last_error}</p>
      <script type="application/json" id="ps-tiktok-confirm-data">${raw(JSON.stringify(data).replace(/</g, "\\u003c"))}</script>
      ${tiktokPanelScript()}<script src="${assetUrl("tiktok-confirmation.js")}"></script>
      <form method="post" action="/queue/${item.post.id}/confirm" x-data="psTikTokConfirmation" @submit="prepare($event)">
        <input type="hidden" name="payload" x-ref="payload" />
        ${tiktokPanel()}
        <button class="btn btn-primary" type="submit" :disabled="!ready">Publish now</button>
        <a class="btn btn-ghost" href="/queue/${item.post.id}">Back to delivery</a>
      </form>` }));
  });
  r.post("/queue/:id/confirm", guard, async (c) => {
    const a = await authenticateSession(c.req.raw).catch(() => null);
    if (!a) return c.text("Unauthorized", 401);
    if (!deliveryIdSchema.safeParse(c.req.param("id")).success) return c.text("Not found", 404);
    try {
      const body = await c.req.parseBody();
      let input: unknown;
      try { input = JSON.parse(String(body.payload ?? "{}")); } catch { return c.text("Invalid form", 400); }
      await confirmTikTokDelivery(c.req.param("id"), a.workspaceId, a.userId, input);
      return c.redirect(`/queue/${c.req.param("id")}`, 303);
    } catch (err) {
      if (err instanceof ApiError) return new Response(err.message, { status: err.status, headers: { "content-type": "text/plain; charset=utf-8" } });
      throw err;
    }
  });
}
