import { Hono } from "hono";
import * as login from "@/server/handlers/auth/login/route";
import * as logout from "@/server/handlers/auth/logout/route";
import * as register from "@/server/handlers/auth/register/route";
import * as oauthFacebook from "@/server/handlers/oauth/facebook/route";
import * as oauthFacebookCallback from "@/server/handlers/oauth/facebook/callback/route";
import * as oauthInstagram from "@/server/handlers/oauth/instagram/route";
import * as oauthInstagramCallback from "@/server/handlers/oauth/instagram/callback/route";
import * as oauthYouTube from "@/server/handlers/oauth/youtube/route";
import * as oauthYouTubeCallback from "@/server/handlers/oauth/youtube/callback/route";
import * as oauthConnect from "@/server/handlers/oauth/connect/route";
import * as oauthConnectCallback from "@/server/handlers/oauth/connect/callback/route";
import * as webhook from "@/server/handlers/webhooks/meta/route";
import * as telegramWebhook from "@/server/handlers/webhooks/telegram/route";
import * as cronTokenRefresh from "@/server/handlers/cron/token-refresh/route";
import * as eventsStream from "./events-stream";

export const special = new Hono();

// Realtime SSE (REALTIME1 · R3) — workspace-scoped live signals; authenticate() inside the handler.
special.get("/events/stream", (c) => eventsStream.GET(c));

// Auth (these set/clear the session cookie on the returned Response)
special.post("/api/auth/login", (c) => login.POST(c.req.raw));
special.post("/api/auth/logout", (c) => logout.POST(c.req.raw));
special.post("/api/auth/register", (c) => register.POST(c.req.raw));

// OAuth (redirects)
special.get("/api/oauth/facebook", (c) => oauthFacebook.GET(c.req.raw));
special.get("/api/oauth/facebook/callback", (c) => oauthFacebookCallback.GET(c.req.raw));
special.get("/api/oauth/instagram", (c) => oauthInstagram.GET(c.req.raw));
special.get("/api/oauth/instagram/callback", (c) => oauthInstagramCallback.GET(c.req.raw));
special.get("/api/oauth/youtube", (c) => oauthYouTube.GET(c.req.raw));
special.get("/api/oauth/youtube/callback", (c) => oauthYouTubeCallback.GET(c.req.raw));
// Generic publish-provider connect (TikTok, X, LinkedIn, Threads) — one handler, platform in the path.
special.get("/api/oauth/connect/:platform", (c) => oauthConnect.GET(c.req.raw, c.req.param("platform")));
special.get("/api/oauth/connect/:platform/callback", (c) => oauthConnectCallback.GET(c.req.raw, c.req.param("platform")));

// Webhooks (Meta) — GET verification, POST signed events
special.get("/api/webhooks/meta", (c) => webhook.GET(c.req.raw));
special.post("/api/webhooks/meta", (c) => webhook.POST(c.req.raw));

// Webhooks (Telegram) — POST updates, verified by per-channel secret header
special.post("/api/webhooks/telegram", (c) => telegramWebhook.POST(c.req.raw));

// Cron
special.get("/api/cron/token-refresh", (c) => cronTokenRefresh.GET(c.req.raw));
