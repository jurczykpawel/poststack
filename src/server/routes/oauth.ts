/**
 * OAuth 2.1 endpoints for MCP clients (Claude, ChatGPT, …): discovery metadata (RFC 9728 / RFC 8414),
 * dynamic registration (RFC 7591), the consent screen, token and revocation. Logic in lib/mcp/oauth.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import { createHmac, timingSafeEqual } from "crypto";
import { authenticateSession } from "@/lib/auth";
import { API_SCOPES, isInstanceScope } from "@/lib/auth/scopes";
import { getClientIp, rateLimit } from "@/lib/api/rate-limit";
import { BRAND } from "@/lib/brand";
import { env } from "@/lib/env";
import { hasFeature } from "@/lib/license/gate";
import {
  AUTHORIZE_PARAMS, OAuthError, createAuthorizationCode, exchangeCode, grantScopes, issuer, mcpResource,
  memberWorkspaces, parseAuthorizeRequest, redirectWith, refreshTokens, registerClient, revokeToken,
  type AuthorizeParams, type AuthorizeRequest, type OAuthAccess,
} from "@/lib/mcp/oauth";
import { requireSameOrigin } from "../middleware/same-origin";
import { doc } from "../ui/layout";
import { brandLogo } from "../ui/branding";

export const oauthRoutes = new Hono();

const publicCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"] });
const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => oauthError(c, new OAuthError("invalid_request", "Request body too large.", 413)) });
for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"]) oauthRoutes.use(path, publicCors);

function oauthError(c: Context, e: unknown): Response {
  if (!(e instanceof OAuthError)) throw e;
  return c.json({ error: e.code, error_description: e.message }, e.status as 400, { "Cache-Control": "no-store" });
}

async function limited(c: Context, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  return !(await rateLimit(`rl:oauth-${bucket}:${getClientIp(c.req.raw)}`, limit, windowSeconds)).allowed;
}

/** Form fields as strings (files and repeated fields ignored). */
async function formFields(c: Context): Promise<Record<string, string | undefined>> {
  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"));
}

// ─── discovery ──────────────────────────────────────────────────────────────

const protectedResource = (c: Context) => c.json({ resource: mcpResource(), authorization_servers: [issuer()], bearer_methods_supported: ["header"], resource_name: BRAND.name });
oauthRoutes.get("/.well-known/oauth-protected-resource", protectedResource);
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => c.json({
  issuer: issuer(),
  authorization_endpoint: `${issuer()}/oauth/authorize`,
  token_endpoint: `${issuer()}/oauth/token`,
  registration_endpoint: `${issuer()}/oauth/register`,
  revocation_endpoint: `${issuer()}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: API_SCOPES.filter((s) => !isInstanceScope(s)),
}));

// ─── registration, token, revocation ────────────────────────────────────────

oauthRoutes.post("/oauth/register", smallBody, async (c) => {
  if (await limited(c, "register", 20, 3600)) return c.json({ error: "slow_down", error_description: "Too many registrations." }, 429);
  try {
    const client = await registerClient(await c.req.json().catch(() => null));
    return c.json({
      client_id: client.id, client_id_issued_at: Math.floor(client.created_at.getTime() / 1000), client_name: client.name,
      redirect_uris: client.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }, 201);
  } catch (e) { return oauthError(c, e); }
});

oauthRoutes.post("/oauth/token", smallBody, async (c) => {
  if (await limited(c, "token", 60, 60)) return c.json({ error: "slow_down", error_description: "Too many token requests." }, 429);
  const f = await formFields(c);
  try {
    if (!(await hasFeature("api_access"))) throw new OAuthError("invalid_grant", "API access needs a PRO license on this instance.");
    const tokens = f.grant_type === "authorization_code" ? await exchangeCode(f)
      : f.grant_type === "refresh_token" ? await refreshTokens(f)
      : null;
    if (!tokens) throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    return c.json(tokens, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
  } catch (e) { return oauthError(c, e); }
});

oauthRoutes.post("/oauth/revoke", smallBody, async (c) => {
  if (await limited(c, "revoke", 60, 60)) return c.json({ error: "slow_down" }, 429);
  const { token } = await formFields(c);
  if (token) await revokeToken(token);
  return c.body(null, 200);
});

// ─── consent screen ─────────────────────────────────────────────────────────

const consentCsrf = (sessionId: string) => createHmac("sha256", env.JWT_SECRET).update(`oauth-consent:${sessionId}`).digest("base64url");
const sameToken = (a: string | undefined, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pickParams = (src: Record<string, string | undefined>): AuthorizeParams => Object.fromEntries(AUTHORIZE_PARAMS.map((k) => [k, src[k]]));

const ACCESS_CHOICES: { id: OAuthAccess; label: string; hint: string }[] = [
  { id: "read", label: "Read only", hint: "See data, change nothing." },
  { id: "write", label: "Read and write", hint: "Also publish, reply and edit." },
];

/** OAuth pages hand the browser over to another app, so they opt out of the app's document transitions. */
function card(title: string, body: ReturnType<typeof html>) {
  return doc(title, html`<style>@view-transition { navigation: none; }</style><div class="auth-wrap"><div class="auth-card" style="max-width:420px">
    <h1 style="display:flex;align-items:center;gap:.75rem">${brandLogo()}${BRAND.name}</h1>${body}</div></div>`);
}

const errorPage = (message: string) => card("Cannot connect app", html`<p class="auth-error" role="alert">${message}</p>`);

/** After the form POST the browser leaves via a refresh (the page's form-action policy only allows this origin). */
const continuePage = (c: Context, url: string) => c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta http-equiv="refresh" content="0;url=${url}" /><title>Returning to the app</title></head>
  <body><p>Returning to the app… <a href="${url}">Continue</a></p></body></html>`);

function consentPage(req: AuthorizeRequest, workspaces: { id: string; name: string }[], current: string, csrf: string) {
  const redirectHost = new URL(req.redirectUri).host;
  const verifiedHost = req.client.id.startsWith("https://") ? new URL(req.client.id).host : null;
  const loopback = new URL(req.redirectUri).protocol === "http:";
  return card(`Connect ${req.client.name}`, html`
    <p><strong>${req.client.name}</strong>${verifiedHost ? html` <span class="muted">(${verifiedHost})</span>` : ""} wants to use your ${BRAND.name} account.</p>
    <p class="muted" style="margin:0">After you approve, you go back to <strong>${redirectHost}</strong>.</p>
    ${loopback ? html`<div class="notice notice-warn">This returns to a program on this computer. Approve only if you just started the connection yourself.</div>` : ""}
    <form method="post" action="/oauth/authorize" x-data="{ access: 'read' }" style="display:flex;flex-direction:column;gap:12px">
      ${AUTHORIZE_PARAMS.map((k) => req.params[k] === undefined ? "" : html`<input type="hidden" name="${k}" value="${req.params[k]}" />`)}
      <input type="hidden" name="csrf" value="${csrf}" />
      ${workspaces.length > 1
        ? html`<label class="label" for="oauth-ws">Workspace</label><select class="input" id="oauth-ws" name="workspace_id">
            ${workspaces.map((w) => html`<option value="${w.id}" ${w.id === current ? "selected" : ""}>${w.name}</option>`)}</select>`
        : html`<input type="hidden" name="workspace_id" value="${workspaces[0]?.id ?? current}" />`}
      <div class="label" id="oauth-access">What can it do?</div>
      <div class="preset-cards" role="radiogroup" aria-labelledby="oauth-access" style="margin:0">
        ${ACCESS_CHOICES.map((a) => html`<label class="preset-card" :class="{ on: access === '${a.id}' }">
          <input type="radio" name="access" value="${a.id}" x-model="access" ${a.id === "read" ? "checked" : ""} /><b>${a.label}</b><span>${a.hint}</span></label>`)}
      </div>
      <button class="btn btn-primary" type="submit" name="decision" value="approve">Approve</button>
      <button class="btn" type="submit" name="decision" value="deny">Deny</button>
    </form>
    <p class="muted" style="font-size:12px;margin:0">You can disconnect it any time in Settings → API keys.</p>`);
}

oauthRoutes.get("/oauth/authorize", async (c) => {
  // Sign-in first: validating the request may fetch the client's metadata document.
  const session = await authenticateSession(c.req.raw);
  if (!session) {
    const here = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(here.pathname + here.search)}`);
  }
  const parsed = await parseAuthorizeRequest(pickParams(c.req.query()));
  if ("fatal" in parsed) return c.html(errorPage(parsed.fatal), 400);
  if ("redirect" in parsed) return c.redirect(parsed.redirect);
  if (!(await hasFeature("api_access"))) return c.html(errorPage("Connecting apps needs API access, a PRO feature of this instance."), 403);
  return c.html(consentPage(parsed.ok, await memberWorkspaces(session.userId), session.workspaceId, consentCsrf(session.sessionId)));
});

oauthRoutes.post("/oauth/authorize", requireSameOrigin, async (c) => {
  const f = await formFields(c);
  const session = await authenticateSession(c.req.raw);
  if (!session || !sameToken(f.csrf, consentCsrf(session.sessionId))) return c.html(errorPage("Your session changed. Start the connection again from the app."), 403);
  const parsed = await parseAuthorizeRequest(pickParams(f));
  if ("fatal" in parsed) return c.html(errorPage(parsed.fatal), 400);
  if ("redirect" in parsed) return continuePage(c, parsed.redirect);
  const req = parsed.ok;
  if (f.decision !== "approve") return continuePage(c, redirectWith(req.redirectUri, { error: "access_denied", state: req.state }));
  if (!(await hasFeature("api_access"))) return c.html(errorPage("Connecting apps needs API access, a PRO feature of this instance."), 403);
  const workspace = (await memberWorkspaces(session.userId)).find((w) => w.id === f.workspace_id);
  if (!workspace || (f.access !== "read" && f.access !== "write")) return c.html(errorPage("Choose a workspace and an access level."), 400);
  const scopes = grantScopes(f.access, req.requestedScopes);
  if (!scopes.length) return continuePage(c, redirectWith(req.redirectUri, { error: "invalid_scope", error_description: "None of the requested scopes fit the chosen access.", state: req.state }));
  const code = await createAuthorizationCode(req, session.userId, workspace.id, scopes);
  return continuePage(c, redirectWith(req.redirectUri, { code, state: req.state }));
});
