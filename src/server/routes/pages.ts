import { Hono } from "hono";
import { html, raw } from "hono/html";
import * as login from "@/server/handlers/auth/login/route";
import * as register from "@/server/handlers/auth/register/route";
import * as logout from "@/server/handlers/auth/logout/route";
import { doc } from "../ui/layout";
import { requireSession } from "../middleware/page-auth";
import { registerDashboard } from "./dashboard";

export const pages = new Hono();

// ─── helpers ────────────────────────────────────────────────────────────────

function htmxRedirect(from: Response, to: string): Response {
  const out = new Response(null, { status: 204 });
  const cookie = from.headers.get("set-cookie");
  if (cookie) out.headers.set("set-cookie", cookie);
  out.headers.set("HX-Redirect", to);
  return out;
}

function captchaWidget() {
  if (!process.env.ALTCHA_HMAC_KEY) return html``;
  return html`
    <altcha-widget name="captchaToken" challengeurl="/api/captcha/challenge" hidelogo hidefooter></altcha-widget>
    <script async defer type="module" src="https://cdn.jsdelivr.net/npm/altcha@2.0.0/dist/altcha.min.js"></script>`;
}

function authPage(opts: { title: string; subtitle: string; action: string; submit: string; alt: ReturnType<typeof html>; nameField: boolean }) {
  return doc(
    opts.title,
    html`<div class="auth-wrap"><div class="auth-box">
  <div class="auth-head"><h1 style="font-size:1.5rem">ReplyStack</h1><p class="muted">${opts.subtitle}</p></div>
  <form class="stack" hx-post="${opts.action}" hx-ext="json-enc" hx-target="#auth-error" hx-swap="innerHTML">
    ${opts.nameField
      ? html`<div><label class="label">Name</label><input class="input" type="text" name="name" autocomplete="name" /></div>`
      : html``}
    <div><label class="label">Email</label><input class="input" type="email" name="email" autocomplete="email" required /></div>
    <div><label class="label">Password</label><input class="input" type="password" name="password" autocomplete="${opts.nameField ? "new-password" : "current-password"}" required /></div>
    <div class="row" style="justify-content:center">${captchaWidget()}</div>
    <div id="auth-error"></div>
    <button class="btn btn-primary" type="submit">${opts.submit}</button>
  </form>
  <p class="muted" style="margin-top:1rem;text-align:center">${opts.alt}</p>
</div></div>`,
  );
}

// ─── auth + home ──────────────────────────────────────────────────────────────

pages.get("/", (c) => c.redirect("/inbox"));

pages.get("/login", (c) =>
  c.html(
    authPage({
      title: "Sign in · ReplyStack",
      subtitle: "Sign in to your account",
      action: "/login",
      submit: "Sign in",
      nameField: false,
      alt: html`No account? <a href="/register">Create one</a>`,
    }),
  ),
);

pages.get("/register", (c) =>
  c.html(
    authPage({
      title: "Register · ReplyStack",
      subtitle: "Create your account",
      action: "/register",
      submit: "Create account",
      nameField: true,
      alt: html`Already have an account? <a href="/login">Sign in</a>`,
    }),
  ),
);

pages.post("/login", async (c) => {
  const res = await login.POST(c.req.raw);
  if (res.status === 200) return htmxRedirect(res, "/inbox");
  const body = await res.json().catch(() => ({}));
  return c.html(html`<p class="error">${raw(escapeText(authErrorMessage(body, "Login failed")))}</p>`);
});

pages.post("/register", async (c) => {
  const res = await register.POST(c.req.raw);
  if (res.status === 201) return htmxRedirect(res, "/inbox");
  const body = await res.json().catch(() => ({}));
  return c.html(html`<p class="error">${raw(escapeText(authErrorMessage(body, "Registration failed")))}</p>`);
});

pages.post("/logout", async (c) => {
  const res = await logout.POST(c.req.raw);
  return htmxRedirect(res, "/login");
});

// Prefer zod field errors (e.g. "Password must be at least 8 characters") over
// the generic top-level "Invalid request data" so the form tells the user what to fix.
function authErrorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: { message?: string; details?: unknown } } | null)?.error;
  if (!error) return fallback;
  if (error.details && typeof error.details === "object") {
    const messages = Object.values(error.details as Record<string, unknown>)
      .flat()
      .filter((m): m is string => typeof m === "string");
    if (messages.length > 0) return messages.join(". ");
  }
  return error.message ?? fallback;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}

// ─── dashboard (session-gated) ────────────────────────────────────────────────
registerDashboard(pages, requireSession);
