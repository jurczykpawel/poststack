import { html } from "hono/html";
import { currentBrand } from "@/lib/brand";
import { PUBLIC_PAGES, publicSiteOrigin } from "./public-site/pages";

export async function brandedDiscovery(rel: string): Promise<string | null> {
  const brand = currentBrand();
  const origin = publicSiteOrigin();
  if (rel === "robots.txt") return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap-index.xml\n`;
  if (rel === "llms.txt") return `# ${brand.name}\n\nSocial media publishing, scheduling, inbox and automation.\n\n## Links\n- Website: ${origin}/\n- App: ${origin}/login\n- Privacy: ${origin}/privacy\n- Terms: ${origin}/terms\n- Contact: ${origin}/contact\n`;
  if (rel === "sitemap-index.xml") return String(await html`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
  if (rel === "sitemap-0.xml") return String(await html`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PUBLIC_PAGES.map(({ path }) => html`<url><loc>${origin}${path}</loc></url>`)}</urlset>`);
  return null;
}
