import type { IconName } from "../components/icons";
import type { Area } from "@/lib/license/areas";
import type { Feature } from "@/lib/license/features";

// One unified navigation across the publishing wing (PostStack) and the replies wing (ReplyStack).
// Each item lives in a section and carries:
//   - `area`:    the functional product it belongs to (publishing / replies / core). When the instance
//                license does not entitle that area, the item is hidden (a replies-only license hides
//                publishing items and vice-versa). `core` items are always shown.
//   - `feature`: an optional finer PRO-gate. When set and the license lacks it, the item renders
//                LOCKED (a 🔒 link to the upgrade page) instead of its real href.
// The shell consumes this to render the sidebar, mobile nav and command palette (DRY: one source).
export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: IconName;
  area: Area;
  feature?: Feature;
  soon?: boolean;
}
export interface NavSection { section: string; items: NavItem[]; }

export const NAV_SECTIONS: NavSection[] = [
  { section: "Overview", items: [
    { key: "overview", label: "Overview", href: "/overview", icon: "dashboard", area: "core" },
    { key: "channels", label: "Channels", href: "/channels", icon: "channels", area: "core" },
    { key: "brands", label: "Brands", href: "/brands", icon: "brands", area: "core", feature: "multi_brand" },
    { key: "sources", label: "Sources", href: "/sources", icon: "sources", area: "core", feature: "managed_connection" },
  ]},
  { section: "Replies", items: [
    { key: "inbox", label: "Inbox", href: "/inbox", icon: "events", area: "replies", feature: "contacts_crm" },
    { key: "approvals", label: "Approvals", href: "/approvals", icon: "queue", area: "replies" },
    { key: "rules", label: "Rules", href: "/rules", icon: "compose", area: "replies" },
    { key: "contacts", label: "Contacts", href: "/contacts", icon: "brands", area: "replies", feature: "contacts_crm" },
    { key: "engagement", label: "Engagement", href: "/engagement", icon: "dashboard", area: "replies", feature: "contacts_crm" },
    { key: "sequences", label: "Sequences", href: "/sequences", icon: "events", area: "replies", feature: "sequences" },
  ]},
  { section: "Publishing", items: [
    { key: "compose", label: "Compose", href: "/compose", icon: "plus", area: "publishing" },
    { key: "content", label: "Content", href: "/content", icon: "compose", area: "publishing" },
    { key: "queue", label: "Queue", href: "/queue", icon: "queue", area: "publishing" },
  ]},
  { section: "Delivery", items: [
    { key: "webhooks", label: "Webhooks", href: "/webhooks", icon: "webhooks", area: "core" },
    { key: "api-keys", label: "API keys", href: "/api-keys", icon: "key", area: "core", feature: "api_access" },
    { key: "events", label: "Events", href: "/events", icon: "events", area: "core" },
  ]},
];

/** The settings foot link (always shown, never gated). */
export const SETTINGS_ITEM: NavItem = { key: "settings", label: "Settings", href: "/settings", icon: "settings", area: "core" };

/** All nav items flattened (sections + settings foot). */
export function allNavItems(): NavItem[] {
  return [...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_ITEM];
}

/** Whether nav `key` is active for the given request path. */
export function isActive(key: string, path: string): boolean {
  if (key === "overview") return path === "/overview" || path === "/" || path === "/overview/";
  const item = allNavItems().find((i) => i.key === key);
  return !!item && item.href !== "#" && (path === item.href || path.startsWith(item.href + "/"));
}

/**
 * Whether an item is visible given the entitled areas. `core` is always visible. A wing item
 * (publishing / replies) is visible when its OWN area is entitled, OR when NO wing is entitled at
 * all (a free / unlicensed instance) — in which case both wings show, gated to LOCKED by feature,
 * so the upgrade funnel still surfaces every product. A license that entitles exactly one wing
 * hides the other (a replies-only license hides publishing, and vice-versa).
 */
export function navItemVisible(item: NavItem, products: Set<Area>): boolean {
  if (item.area === "core") return true;
  const anyWing = products.has("publishing") || products.has("replies");
  if (!anyWing) return true; // free / unlicensed → show both wings (locked by feature)
  return products.has(item.area);
}
