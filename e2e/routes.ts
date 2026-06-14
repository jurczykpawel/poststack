// The route list + per-state gating EXPECTATIONS, derived from the app's single nav source of truth
// (src/server/ui/shell/nav.ts) — DRY, so a nav change is reflected here automatically. nav.ts imports
// only erased `import type`s, so it loads under Playwright's loader without resolving the `@/` alias.
import { NAV_SECTIONS, SETTINGS_ITEM, type NavItem } from "../src/server/ui/shell/nav";

export interface RouteCase {
  key: string;
  href: string;
  area: "core" | "publishing" | "replies";
  feature?: string;
}

/** Every nav destination (sections + settings foot). */
export function navRoutes(): RouteCase[] {
  const items: NavItem[] = [...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_ITEM];
  return items.map((it) => ({ key: it.key, href: it.href, area: it.area, feature: it.feature }));
}

// Which nav features are unlocked in each state. FREE = no token → every feature locked (all features
// are minTier >= pro). PRO (our minted token = tier business + all areas) = every feature unlocked.
export function featureUnlocked(state: "free" | "pro", _feature: string | undefined): boolean {
  return state === "pro";
}

// Routes that render a full-page proLockMain upsell when their feature is locked (FREE). Discovered
// from the route handlers: inbox/contacts/engagement/sequences gate the WHOLE page. The rest render
// the page and gate individual affordances (sidebar lock link / in-form 🔒 PRO / disabled controls).
export const PAGE_LOCKED_WHEN_LOCKED = new Set(["inbox", "contacts", "engagement", "sequences"]);

// api-keys is a redirect-to-settings nav target (no own page); assert the landing URL is /settings.
export const REDIRECTS: Record<string, string> = { "api-keys": "/settings" };
