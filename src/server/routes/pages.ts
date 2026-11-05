import { Hono } from "hono";
import { html, raw } from "hono/html";
import * as login from "@/server/handlers/auth/login/route";
import * as register from "@/server/handlers/auth/register/route";
import * as logout from "@/server/handlers/auth/logout/route";
import { doc } from "../ui/layout";
import { requireSession } from "../middleware/page-auth";
import { registerDashboard } from "./dashboard";
import { brandLogo } from "../ui/branding";
import { BRAND } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { getConfig } from "@/lib/settings/config";

export const pages = new Hono();

// ─── helpers ────────────────────────────────────────────────────────────────

function htmxRedirect(from: Response, to: string): Response {
  const out = new Response(null, { status: 204 });
  const cookie = from.headers.get("set-cookie");
  if (cookie) out.headers.set("set-cookie", cookie);
  out.headers.set("HX-Redirect", to);
  return out;
}

async function captchaWidget() {
  if (!(await getConfig("ALTCHA_HMAC_KEY"))) return null;
  // Keep the invisible widget form-associated so htmx receives its solved token.
  return html`
    <altcha-widget name="captchaToken" challenge="/api/captcha/challenge" auto="onload" display="invisible" style="display:none"></altcha-widget>
    <script type="module" src="https://cdn.jsdelivr.net/npm/altcha@3.5.0/dist/main/altcha.min.js"></script>
    <script type="module">
      const widget = document.querySelector("altcha-widget");
      const form = widget.closest("form");
      const submit = form.querySelector('button[type="submit"]');
      // The widget marks its hidden checkbox invalid during PoW; handle validation inline.
      form.noValidate = true;
      const label = submit.textContent;
      const error = form.querySelector("#auth-error");
      let state = "unverified", pending = false, sending = false;
      const restore = () => { submit.disabled = false; submit.textContent = label; };
      form.addEventListener("submit", (event) => {
        const valid = Array.from(form.querySelectorAll("input")).every((input) => widget.contains(input) || input.reportValidity());
        if (valid && state === "verified" && !sending) { sending = true; return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!valid || pending || sending) return;
        pending = true;
        error.textContent = "";
        submit.disabled = true;
        submit.textContent = "Verifying…";
        if (state === "error" || state === "expired") widget.verify();
      }, true);
      widget.addEventListener("statechange", (event) => {
        state = event.detail.state;
        if (state === "verified" && pending) {
          pending = false;
          restore();
          // Let the widget flush its form value before htmx reads FormData.
          setTimeout(() => form.requestSubmit(submit), 0);
        } else if (state === "error" || state === "expired") {
          pending = false;
          restore();
          error.textContent = "Verification failed. Please try again.";
        }
      });
      form.addEventListener("htmx:afterRequest", (event) => {
        if (event.detail.elt !== form || event.detail.xhr.getResponseHeader("HX-Redirect")) return;
        sending = false;
        restore();
        widget.reset();
        widget.verify();
      });
    </script>`;
}

async function authPage(opts: { title: string; subtitle: string; action: string; submit: string; alt: ReturnType<typeof html>; nameField: boolean }) {
  const captcha = await captchaWidget();
  return doc(
    opts.title,
    html`<div class="auth-wrap"><div class="auth-card">
  <h1 style="display:flex;align-items:center;gap:.75rem">${brandLogo()}${BRAND.name}</h1><p class="muted">${opts.subtitle}</p>
  <form hx-post="${opts.action}" hx-ext="json-enc" hx-target="#auth-error" hx-swap="innerHTML">
    ${opts.nameField
      ? html`<div class="fld"><span>Name</span><input type="text" name="name" autocomplete="name" /></div>`
      : html``}
    <div class="fld"><span>Email</span><input type="email" name="email" autocomplete="email" required /></div>
    <div class="fld"><span>Password</span><input type="password" name="password" autocomplete="${opts.nameField ? "new-password" : "current-password"}" required /></div>
    <div class="row" style="justify-content:center">${captcha ?? ""}</div>
    <div id="auth-error" role="alert"></div>
    <button class="btn btn-primary" type="submit">${opts.submit}</button>
  </form>
  <p class="muted" style="margin-top:1rem;text-align:center">${opts.alt}</p>
</div></div>`,
  );
}

// ─── auth + home ──────────────────────────────────────────────────────────────

// `/` is served by landingRoutes (the marketing homepage); a logged-in visitor is redirected to
// /overview there. See src/server/routes/landing.ts (LANDING1).

pages.get("/login", async (c) =>
  c.html(
    await authPage({
      title: t("title.signIn"),
      subtitle: "Sign in to your account",
      action: "/login",
      submit: "Sign in",
      nameField: false,
      alt: html`No account? <a href="/register">Create one</a>`,
    }),
  ),
);

pages.get("/register", async (c) =>
  c.html(
    await authPage({
      title: t("title.register"),
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
  return c.html(html`<p class="auth-error">${raw(escapeText(authErrorMessage(body, "Login failed")))}</p>`);
});

pages.post("/register", async (c) => {
  const res = await register.POST(c.req.raw);
  if (res.status === 201) return htmxRedirect(res, "/inbox");
  const body = await res.json().catch(() => ({}));
  return c.html(html`<p class="auth-error">${raw(escapeText(authErrorMessage(body, "Registration failed")))}</p>`);
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
  // validation_error carries `details: [{ path, message }]` — surface the field messages so the
  // form shows e.g. "Password must be at least 8 characters" rather than the generic envelope text.
  if (Array.isArray(error.details)) {
    const messages = (error.details as Array<{ message?: unknown }>)
      .map((d) => d?.message)
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
