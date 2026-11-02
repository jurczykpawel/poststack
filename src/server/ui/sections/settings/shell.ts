import type { Context } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { authenticate, type AuthContext } from "@/lib/auth";
import { isInstanceOperator } from "@/lib/auth/instance-operator";
import { getInstanceLicense } from "@/lib/license/gate";
import { t } from "@/lib/i18n";
import { dashboardDoc } from "../../layout";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export async function settingsAuth(c: Context): Promise<AuthContext | null> {
  return authenticate(c.req.raw).catch(() => null);
}

/** UXFLOW1 stage 7: each Settings tab is its own address. The first four belong to this workspace,
 *  the last two to the whole installation and are shown only to the instance operator. */
const TABS = [
  { path: "/settings/account", label: "Account", operator: false },
  { path: "/settings/api-keys", label: "API keys", operator: false },
  { path: "/settings/ai", label: "AI", operator: false },
  { path: "/settings/data", label: "Data", operator: false },
  { path: "/settings/integrations", label: "Integrations", operator: true },
  { path: "/settings/license", label: "License", operator: true },
] as const;

export type SettingsTab = (typeof TABS)[number]["path"];

// Old one-page tabs were `/settings#<tab>`. `/settings` redirects without a fragment, so the browser
// keeps the old fragment on the new address; this maps it to the page that holds that content now.
const LEGACY_HASHES: Record<string, string> = {
  account: "/settings/account", apikeys: "/settings/api-keys", license: "/settings/license",
  integrations: "/settings/integrations", sources: "/channels#sources", automation: "/settings/ai",
  data: "/settings/data", alert: "/webhooks#outgoing",
};
const legacyScript = raw(`<script>(function(){var m=${JSON.stringify(LEGACY_HASHES).replace(/"(\w+)":/g, "$1:")};var t=m[location.hash.slice(1)];if(t&&t!==location.pathname)location.replace(t)})()</script>`);

/** The Settings frame: title, the top tabs (links, current one marked) and the page body. */
export async function settingsPage(c: Context, a: AuthContext, tab: SettingsTab, body: Html): Promise<Response> {
  const [license, operator] = await Promise.all([getInstanceLicense(), isInstanceOperator(a)]);
  const tabs = TABS.filter((x) => operator || !x.operator || x.path === tab);
  return c.html(dashboardDoc(
    t("title.suffix", { section: "Settings" }),
    "/settings",
    html`${legacyScript}<div class="page">
      <h1>Settings</h1>
      <nav class="settings-tabs" aria-label="Settings">
        ${tabs.map((x) => html`<a ${x.operator ? raw('data-inst title="Whole installation" ') : ""}${x.path === tab
          ? raw(`class="settings-tab active" aria-current="page"`)
          : raw(`class="settings-tab"`)} href="${x.path}">${x.label}</a>`)}
      </nav>
      ${body}
    </div>`,
    license.features,
    license.products,
  ));
}

export const managedByOperator = html`<p class="muted">Managed by the instance operator</p>`;
