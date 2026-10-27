import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const httpsUrl = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Use an HTTPS URL without credentials");
const imageUrl = z.union([z.literal(""), httpsUrl, z.string().max(2048).regex(/^\/(?!\/)[\w/.-]+$/)]);
const line = (max: number) => z.string().trim().max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Use a single line");

// Shape follows the standalone publisher configuration: identity, assets, theme and contact.
export const brandingSchema = z.object({
  name: line(80).min(1),
  logoUrl: imageUrl,
  faviconUrl: imageUrl,
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  theme: z.enum(["dark", "light"]),
  contactEmail: z.email().max(254),
  publicUrl: httpsUrl.refine((value) => URL.canParse(value) && new URL(value).origin === value, "Use an origin without a path or trailing slash"),
  footer: line(240),
}).strict();
export type InstanceBrand = z.infer<typeof brandingSchema>;
export const DEFAULT_BRAND: InstanceBrand = {
  name: "PostStack", logoUrl: "", faviconUrl: "/favicon.svg", accent: "#5b8cff", theme: "dark",
  contactEmail: "kontakt@techskills.academy", publicUrl: "https://poststack.techskills.academy",
  footer: "Part of TechSkills Academy",
};

const context = new AsyncLocalStorage<InstanceBrand>();
export function withBrand<T>(brand: InstanceBrand, action: () => T): T {
  return context.run(brand, action);
}
export function currentBrand(): InstanceBrand {
  return context.getStore() ?? DEFAULT_BRAND;
}
export function isWhiteLabel(): boolean {
  return currentBrand() !== DEFAULT_BRAND;
}
export async function getInstanceBrand(): Promise<InstanceBrand> {
  const { getConfig } = await import("./settings/config");
  const value = await getConfig("INSTANCE_BRANDING");
  if (!value) return DEFAULT_BRAND;
  try {
    const { hasFeature } = await import("./license/gate");
    if (!(await hasFeature("white_label"))) return DEFAULT_BRAND;
    return brandingSchema.parse(JSON.parse(value));
  } catch {
    return DEFAULT_BRAND;
  }
}

// Display identity is request-local. Issued keys, cookies and tokens retain stable identifiers.
export const BRAND = {
  get name() { return currentBrand().name; },
  idPrefix: "sk_live_", cookieName: "session", jwtIssuer: "stack",
} as const;

export function brandUserAgent(brand: InstanceBrand): string {
  return `${encodeURIComponent(brand.name)}/1.0 (+${brand.publicUrl})`;
}
