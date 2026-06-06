import { Hono } from "hono";
import * as login from "@/server/handlers/auth/login/route";
import * as logout from "@/server/handlers/auth/logout/route";
import * as register from "@/server/handlers/auth/register/route";
import * as oauthFacebook from "@/server/handlers/oauth/facebook/route";
import * as oauthFacebookCallback from "@/server/handlers/oauth/facebook/callback/route";
import * as oauthInstagram from "@/server/handlers/oauth/instagram/route";
import * as oauthInstagramCallback from "@/server/handlers/oauth/instagram/callback/route";
import * as webhook from "@/server/handlers/webhooks/meta/route";
import * as cronTokenRefresh from "@/server/handlers/cron/token-refresh/route";

export const special = new Hono();

// Auth (these set/clear the rs_session cookie on the returned Response)
special.post("/api/auth/login", (c) => login.POST(c.req.raw));
special.post("/api/auth/logout", (c) => logout.POST(c.req.raw));
special.post("/api/auth/register", (c) => register.POST(c.req.raw));

// OAuth (redirects)
special.get("/api/oauth/facebook", (c) => oauthFacebook.GET(c.req.raw));
special.get("/api/oauth/facebook/callback", (c) => oauthFacebookCallback.GET(c.req.raw));
special.get("/api/oauth/instagram", (c) => oauthInstagram.GET(c.req.raw));
special.get("/api/oauth/instagram/callback", (c) => oauthInstagramCallback.GET(c.req.raw));

// Webhooks (Meta) — GET verification, POST signed events
special.get("/api/webhooks/meta", (c) => webhook.GET(c.req.raw));
special.post("/api/webhooks/meta", (c) => webhook.POST(c.req.raw));

// Cron
special.get("/api/cron/token-refresh", (c) => cronTokenRefresh.GET(c.req.raw));
