import { html } from "hono/html";
import { currentBrand } from "@/lib/brand";
import { PUBLIC_PAGES } from "./public-site/pages";

export async function brandedDiscovery(rel: string): Promise<string | null> {
  const brand = currentBrand();
  if (rel === "robots.txt") return `User-agent: *\nAllow: /\n\nSitemap: ${brand.publicUrl}/sitemap-index.xml\n`;
  if (rel === "llms.txt") return `# ${brand.name}\n\nSocial media publishing, scheduling, inbox and automation.\n\n## Links\n- Website: ${brand.publicUrl}/\n- App: ${brand.publicUrl}/login\n- Privacy: ${brand.publicUrl}/privacy\n- Terms: ${brand.publicUrl}/terms\n- Contact: ${brand.publicUrl}/contact\n`;
  if (rel === "sitemap-index.xml") return String(await html`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${brand.publicUrl}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
  if (rel === "sitemap-0.xml") return String(await html`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PUBLIC_PAGES.map(({ path }) => html`<url><loc>${brand.publicUrl}${path}</loc></url>`)}</urlset>`);
  return null;
}
