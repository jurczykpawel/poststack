import { Hono } from "hono";
import * as login from "@/app/api/auth/login/route";
import * as logout from "@/app/api/auth/logout/route";
import * as register from "@/app/api/auth/register/route";
import * as oauthFacebook from "@/app/api/oauth/facebook/route";
import * as oauthFacebookCallback from "@/app/api/oauth/facebook/callback/route";
import * as oauthInstagram from "@/app/api/oauth/instagram/route";
import * as oauthInstagramCallback from "@/app/api/oauth/instagram/callback/route";
import * as webhook from "@/app/api/webhooks/meta/route";
import * as cronTokenRefresh from "@/app/api/cron/token-refresh/route";

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
