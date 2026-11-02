import type { Context, Hono, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, workspaces } from "@/db/schema";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { MAX_RETENTION_DAYS } from "@/lib/retention";
import { settingsAuth, settingsPage } from "./shell";
import { registerApiKeySettings } from "./api-keys";
import { registerAiSettings } from "./ai";
import { registerIntegrationSettings } from "./integrations";
import { registerLicenseSettings } from "./license";

/** UXFLOW1 stage 7: Settings as separate addresses (shell.ts draws the top tabs). */
export function registerSettings(app: Hono, guard: MiddlewareHandler, jsonReq: (c: Context, body: unknown) => Request): void {
  // No fragment on the target, so the browser keeps an old `#tab` and shell.ts forwards it.
  app.get("/settings", guard, (c) => c.redirect("/settings/account"));
  registerApiKeySettings(app, guard, jsonReq);
  registerAiSettings(app, guard);
  registerIntegrationSettings(app, guard);
  registerLicenseSettings(app, guard);

  app.get("/settings/account", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.redirect("/login");
    return settingsPage(c, a, "/settings/account", html`<section class="section">
      <h2>Change password</h2>
      <form hx-post="/settings/password" hx-ext="json-enc" hx-target="#password-msg" hx-swap="innerHTML" class="stack" style="max-width:24rem">
        <div><label class="label">Current password</label><input class="input" type="password" name="current_password" autocomplete="current-password" required /></div>
        <div><label class="label">New password (min 8 chars)</label><input class="input" type="password" name="new_password" autocomplete="new-password" minlength="8" required /></div>
        <div class="row"><button class="btn btn-primary" type="submit">Update password</button></div>
      </form>
      <p id="password-msg" class="muted" style="margin-top:.5rem"></p>
    </section>`);
  });

  app.get("/settings/data", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.redirect("/login");
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, a.workspaceId), columns: { message_retention_days: true } });
    return settingsPage(c, a, "/settings/data", html`<section class="section">
      <h2>Data retention</h2>
      <p class="muted" style="margin-bottom:1rem">Delete messages older than N days (runs daily). Blank = keep forever. Pending messages are never deleted.</p>
      <form hx-post="/settings/retention" hx-ext="json-enc" hx-target="#retention-msg" hx-swap="innerHTML" style="display:flex;flex-direction:row;align-items:center;gap:.5rem;flex-wrap:nowrap">
        <input class="input" style="width:7rem;flex:0 0 auto" type="number" min="1" name="message_retention_days" placeholder="Keep forever"
          value="${workspace?.message_retention_days ?? ""}" />
        <span class="muted" style="flex:0 0 auto">days</span>
        <button class="btn btn-primary" type="submit" style="flex:0 0 auto">Save</button>
      </form>
      <p id="retention-msg" class="muted" style="margin-top:.5rem"></p>
      <p class="muted" style="margin-top:1rem;font-size:.85rem">
        ${env.HISTORY_RETENTION_DAYS > 0
          ? html`Webhook events and post reactions are compacted automatically after
              <strong>${env.HISTORY_RETENTION_DAYS} days</strong> — rolled into aggregates (all-time
              counts and the Engagement view stay correct) and the raw rows are removed, so the
              database stays small. Configured by the operator via <code>HISTORY_RETENTION_DAYS</code>.`
          : html`Automatic compaction of webhook events and post reactions is
              <strong>disabled</strong> (<code>HISTORY_RETENTION_DAYS=0</code>) — those tables grow
              without bound. Set a value (≥ 30 days) to keep the database small.`}
      </p>
    </section>`);
  });

  app.post("/settings/password", guard, async (c) => {
    const a = await settingsAuth(c);
    if (!a) return c.body(null, 401, { "HX-Redirect": "/login" });
    const form = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const current = form.current_password ?? "";
    const next = form.new_password ?? "";
    if (next.length < 8) return c.html(html`<span class="error">New password must be at least 8 characters.</span>`);
    const user = await db.query.users.findFirst({ where: eq(users.id, a.userId), columns: { password_hash: true } });
    if (!user?.password_hash || !(await verifyPassword(current, user.password_hash))) {
      return c.html(html`<span class="error">Current password is incorrect.</span>`);
    }
    await db.update(users).set({ password_hash: await hashPassword(next) }).where(eq(users.id, a.userId));
    return c.html(html`<span style="color:var(--ok-text)">Password updated.</span>`);
  });

  app.post("/settings/retention", guard, async (c) => {
    const form = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const rawDays = (form as Record<string, unknown>).message_retention_days;
    const days = rawDays === "" || rawDays == null ? null : Number(rawDays);
    // Validate server-side: the input's min="1" is client-only. A direct POST with 0/negative
    // makes the prune cutoff `now` (or the future) and the next retention run deletes EVERY
    // prunable message in the workspace. Require a whole number in a sane range.
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS)) {
      return c.html(html`Retention must be a whole number of days between 1 and ${MAX_RETENTION_DAYS}.`);
    }
    const a = await settingsAuth(c);
    let saved = false;
    if (a) {
      try {
        await db.update(workspaces).set({ message_retention_days: days }).where(eq(workspaces.id, a.workspaceId));
        saved = true;
      } catch { /* reported below */ }
    }
    return c.html(html`${saved ? "Saved." : "Could not save retention policy."}`);
  });
}
