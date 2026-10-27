import { html, raw } from "hono/html";
import { currentBrand } from "@/lib/brand";
import { assetUrl } from "./assets";
import { brandingHead, brandingFooter, brandLogo } from "./branding";

async function escapeText(value: string): Promise<string> {
  return String(await html`${value}`);
}

/** Reuse the built legal content in the instance shell; the public homepage has no baked-in assets. */
export async function brandedLanding(source: string, rel: string): Promise<string> {
  const brand = currentBrand();
  const legal = rel === "privacy/index.html" || rel === "terms/index.html";
  const title = legal ? rel.startsWith("privacy") ? "Privacy Policy" : "Terms of Service" : brand.name;
  let content;
  if (legal) {
    const main = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    if (!main) throw new Error("Legal content missing from landing build");
    const name = await escapeText(brand.name);
    const email = await escapeText(brand.contactEmail);
    const publicUrl = await escapeText(brand.publicUrl);
    const privacy = rel.startsWith("privacy") ? main.replace(/<h2>2\. Cookies[\s\S]*?(?=<h2>4\.)/, '<h2>2. Website cookies</h2><p>The application uses the session cookie to keep you signed in and ps_theme to remember your theme. This public website does not load analytics or marketing trackers.</p>') : main;
    const body = privacy
      .replaceAll("Paweł Jurczyk (TechSkills Academy), Poland", () => name + " instance operator")
      .replaceAll("TechSkills Academy", () => name + " instance operator")
      .replaceAll("https://poststack.techskills.academy", () => publicUrl)
      .replaceAll("kontakt@techskills.academy", () => email)
      .replaceAll("PostStack", () => name);
    content = raw(body);
  } else {
    content = html`<h1>${brand.name}</h1><p>Publish, schedule and manage your social channels in one place.</p>
      <h2>Publishing and scheduling</h2><p>Prepare captions and media, preview content, select your channel and publishing options, then publish or schedule it. Follow delivery results in your queue.</p>
      <h2>Connected channels</h2><p>Connect accounts you manage on TikTok, Facebook, Instagram, YouTube, LinkedIn, Threads and X. Available actions depend on each platform's permissions and application approval.</p>
      <h2>Inbox and automation</h2><p>Manage conversations, keyword replies, contacts and drip sequences for supported messaging channels.</p>
      <h2>Getting started</h2><p>Sign in, connect your account in Channels, then open Compose to create your first post. Review privacy, interactions and commercial disclosures before sending.</p>
      <p><a class="btn btn-primary" href="/login">Sign in</a></p><h2>Support</h2>
      <p>Contact <a href="mailto:${brand.contactEmail}">${brand.contactEmail}</a> for account, service and data requests.</p>`;
  }
  return String(await html`<!doctype html><html lang="en" data-theme="${brand.theme}"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title} · ${brand.name}</title><link rel="canonical" href="${brand.publicUrl}${legal ? rel.startsWith("privacy") ? "/privacy" : "/terms" : "/"}" />
    <link rel="stylesheet" href="${assetUrl("tokens.css")}" /><link rel="stylesheet" href="${assetUrl("admin.css")}" />${brandingHead()}</head><body>
    <style>.instance-public{max-width:72rem;margin:auto;padding:2rem 1.25rem;overflow-wrap:anywhere}.instance-public h1{font-size:clamp(2rem,5vw,3rem)}.instance-public h2{margin-top:2rem}.instance-public p,.instance-public li{line-height:1.7;max-width:75ch}.instance-public p{margin:1rem 0}.instance-public table{display:block;overflow:auto}.instance-public header{display:flex;align-items:center;gap:.75rem;margin-bottom:2rem}.instance-public a{color:var(--accent)}.instance-public .btn{color:var(--accent-contrast)}</style>
    <div class="instance-public"><header><a href="/" aria-label="${brand.name} home">${brandLogo()}</a><strong>${brand.name}</strong></header>
    <main id="main">${content}</main></div>${brandingFooter()}</body></html>`);
}

export async function brandedDiscovery(rel: string): Promise<string | null> {
  const brand = currentBrand();
  if (rel === "robots.txt") return `User-agent: *\nAllow: /\n\nSitemap: ${brand.publicUrl}/sitemap-index.xml\n`;
  if (rel === "llms.txt") return `# ${brand.name}\n\nSocial media publishing, scheduling, inbox and automation.\n\n## Links\n- Website: ${brand.publicUrl}/\n- App: ${brand.publicUrl}/login\n- Privacy: ${brand.publicUrl}/privacy\n- Terms: ${brand.publicUrl}/terms\n- Contact: ${brand.contactEmail}\n`;
  if (rel === "sitemap-index.xml") return String(await html`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${brand.publicUrl}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
  if (rel === "sitemap-0.xml") return String(await html`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/privacy", "/terms"].map((path) => html`<url><loc>${brand.publicUrl}${path}</loc></url>`)}</urlset>`);
  return null;
}
