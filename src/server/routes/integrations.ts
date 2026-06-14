import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import crypto from "node:crypto";
import { ok, ApiError, apiErrorResponse, ApiErrors } from "@/lib/api/response";
import { registerKnownMedia as defaultRegister } from "@/lib/media/service";
import { getStorage } from "@/lib/storage";
import type { Storage } from "@/lib/storage/types";

const FRESHNESS_MS = 5 * 60 * 1000;
// Hard cap on the webhook body. This route is mounted outside the /api/v1 bodyLimit, so without this
// an enabled webhook would buffer an arbitrary body via c.req.text(). 256 KB is plenty for a
// reel.completed payload.
const MAX_BODY_BYTES = 256 * 1024;

export interface IntegrationsDeps {
  registerKnownMedia?: typeof defaultRegister;
  /** Override storage for testing; defaults to getStorage() (lazy). */
  storage?: Storage;
}

/**
 * Optional inbound integration webhooks (HMAC-authenticated, NOT Bearer-auth). Mounted at "/" outside
 * /api/v1 so the API-key middleware does not apply. The ReelStack webhook is OFF by default: it
 * requires BOTH REELSTACK_WEBHOOK_SECRET (HMAC shared secret) and REELSTACK_WEBHOOK_WORKSPACE_ID (the
 * workspace a completed reel is registered into — this app is multi-tenant, so a global integration
 * must name its target tenant). Either missing ⇒ 404 (disabled).
 */
export function integrationsRoutes(deps: IntegrationsDeps = {}) {
  const register = deps.registerKnownMedia ?? defaultRegister;
  const r = new Hono();

  r.post(
    "/integrations/reelstack/webhook",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ data: null, error: { code: "payload_too_large", message: "Request body too large" } }, 413),
    }),
    async (c) => {
      const secret = process.env.REELSTACK_WEBHOOK_SECRET;
      const workspaceId = process.env.REELSTACK_WEBHOOK_WORKSPACE_ID;
      if (!secret || !workspaceId) throw new ApiError("not_found", "Integration disabled", 404); // off by default

      const raw = await c.req.text();
      const sig = c.req.header("x-reelstack-signature") ?? "";
      const ts = c.req.header("x-reelstack-timestamp") ?? "";
      if (!ts || !Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > FRESHNESS_MS)
        throw new ApiError("unauthorized", "Stale or missing timestamp", 401);

      const expected = crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf))
        throw new ApiError("unauthorized", "Bad signature", 401);

      let payload: { event?: string; status?: string; outputSha256?: string };
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ApiError("invalid_request", "Bad JSON", 400);
      }

      if (payload.event === "reel.completed" && payload.status === "completed" && payload.outputSha256) {
        const storage = deps.storage ?? getStorage();
        try {
          // ReelStack reels are always MP4; mime is fixed so the CAS key matches what ReelStack wrote.
          await register({ checksum: payload.outputSha256, mime: "video/mp4", kind: "video" }, { storage }, workspaceId);
        } catch (e) {
          // not_present → reel isn't in our bucket (different bucket / standalone / race). Ack anyway:
          // ReelStack treats a delivered POST as done and won't replay, and registerKnownMedia is idempotent.
          if (!(e instanceof ApiError && e.code === "not_present")) throw e;
        }
      }

      return ok({ received: true });
    },
  );

  // Error envelope (ApiError → status/body). Load-bearing because this router is mounted OUTSIDE
  // /api/ — the app-level onError only converts /api/ paths, so without this an ApiError here would
  // surface as Hono's plain-text 500 instead of the { data, error } envelope.
  r.onError((err) => {
    if (err instanceof ApiError) return apiErrorResponse(err);
    console.error(`integrations webhook error: ${err instanceof Error ? err.message : String(err)}`);
    return ApiErrors.internal();
  });

  return r;
}
