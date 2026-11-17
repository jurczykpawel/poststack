import { html, raw } from "hono/html";
import { currentBrand, isWhiteLabel } from "@/lib/brand";
import { brandingHead, brandLogo } from "../branding";
import { PUBLIC_PAGES, publicSiteOrigin, type PublicPage } from "./pages";
import { publicSiteConfig } from "./config";
import { locale, publicContent, workflowIllustration } from "./locales/en";
import { publicStyles } from "./styles";

function brandColours(accent: string) {
  const rgb = accent.slice(1).match(/../g)!.map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  return `:root[data-theme]{--site-accent:${accent};--site-cta:${accent};--site-cta-hover:${accent};--site-on-cta:${luminance > .179 ? "#0E0E12" : "#FBFBF8"};--site-soft:color-mix(in srgb,${accent} 10%,transparent)}`;
}

export async function renderPublicPage(page: PublicPage) {
  const brand = currentBrand();
  const origin = publicSiteOrigin();
  const config = await publicSiteConfig();
  const home = page.path === "/";
  const document = !["/", "/features", "/how-it-works"].includes(page.path);
  const description = locale.description(page.title, brand.name);
  const nav = (pages: readonly PublicPage[]) => pages.map(p => html`<a href="${p.path}" aria-current="${p.path === page.path ? "page" : "false"}">${p.label}</a>`);
  const groups = [PUBLIC_PAGES.slice(0, 4), PUBLIC_PAGES.slice(4, 6), PUBLIC_PAGES.slice(6)];
  const groupLabels = [locale.product, locale.resources, locale.legal];
  const structured = { "@context": "https://schema.org", "@type": "WebApplication", name: brand.name, url: origin, applicationCategory: "BusinessApplication", operatingSystem: "Web", description };
  return html`<!doctype html><html lang="${locale.lang}" data-theme="${isWhiteLabel() ? brand.theme : "auto"}"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${page.title} · ${brand.name}</title><meta name="description" content="${description}" />
    <link rel="canonical" href="${origin}${page.path}" /><link rel="alternate" hreflang="en" href="${origin}${page.path}" />
    <meta property="og:title" content="${page.title} · ${brand.name}" /><meta property="og:description" content="${description}" /><meta property="og:type" content="website" /><meta property="og:url" content="${origin}${page.path}" /><meta property="og:locale" content="en_GB" />
    <meta property="og:image" content="${origin}/public-site-${page.path.slice(1) || "home"}.png" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:type" content="image/png" /><meta property="og:image:alt" content="${page.title}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="preload" href="/static/public-site/geologica-var.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/static/public-site/source-sans-3-var.woff2" as="font" type="font/woff2" crossorigin />
    ${brandingHead()}
    <script>(function(){try{var t=localStorage.getItem('public-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;else if(document.documentElement.dataset.theme==='auto')document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}catch(e){}})();</script>
    <style>${raw(publicStyles)}${isWhiteLabel() ? raw(brandColours(brand.accent)) : ""}</style>
    <script type="application/ld+json">${raw(JSON.stringify(structured).replaceAll("<", "\\u003c"))}</script>
    </head><body><a class="skip" href="#main">${locale.skip}</a>
    <header class="site-header"><div class="shell masthead"><a class="identity" href="/">${brandLogo()}<span>${brand.name}</span></a>
      <nav class="primary-nav" aria-label="${locale.mainNav}">${nav(PUBLIC_PAGES.slice(1, 4))}</nav>
      <details class="site-menu"><summary>${locale.menu}</summary><nav aria-label="${locale.menu}">${nav(PUBLIC_PAGES)}</nav></details>
      <a class="app-link" href="/login">${locale.app}</a></div></header>
    <main id="main" class="shell ${document ? "document" : ""}">
      ${home ? html`<div class="hero"><div><p class="eyebrow">${locale.overview}</p><h1>${page.title}</h1><p class="lead">${locale.heroLead(brand.name)}</p><a class="app-link" href="/login">${locale.app}</a></div>${workflowIllustration()}</div>` : html`<div class="page-heading"><p class="eyebrow">${brand.name} / ${page.label}</p><h1>${page.title}</h1></div>`}
      <div class="page-content">${publicContent(page, config)}</div>
      ${document ? html`<aside class="related"><strong>${locale.related}</strong>${nav(PUBLIC_PAGES.filter(p => ["/contact", "/privacy", "/terms", "/data-deletion"].includes(p.path) && p.path !== page.path))}</aside>` : ""}
    </main>
    ${home ? html`<section class="finale" aria-labelledby="next-title"><div class="shell"><h2 id="next-title">${locale.next}</h2><div><p>${locale.nextText}</p><a class="app-link" href="/login">${locale.app}</a></div></div></section>` : ""}
    <footer class="site-footer"><div class="shell"><div class="footer-grid"><div class="footer-identity"><a class="identity" href="/">${brandLogo()}<strong>${brand.name}</strong></a><p>${locale.signature}</p><p>${brand.footer}</p></div>${groups.map((pages, i) => html`<nav class="footer-group" aria-label="${i === 0 ? locale.footerNav : groupLabels[i]}"><strong>${groupLabels[i]}</strong>${nav(pages)}</nav>`)}</div>
      <div class="footer-bottom"><span>© ${new Date().getFullYear()} ${brand.name}${!isWhiteLabel() ? html` · <a href="https://techskills.academy">TechSkills Academy</a>` : ""}</span>
      <label class="theme-control" hidden><span>${locale.theme}</span><select id="public-theme"><option value="system" ${!isWhiteLabel() ? raw("selected") : ""}>${locale.system}</option><option value="light" ${isWhiteLabel() && brand.theme === "light" ? raw("selected") : ""}>${locale.light}</option><option value="dark" ${isWhiteLabel() && brand.theme === "dark" ? raw("selected") : ""}>${locale.dark}</option></select></label></div></div></footer>
    <script>document.querySelectorAll('[data-contact]').forEach(function(button){button.addEventListener('click',function(){var email=button.dataset.contact.split(',').map(function(n){return String.fromCodePoint(Number(n))}).join('');var link=document.createElement('a');link.href='mailto:'+email;link.textContent=email;button.replaceWith(link);link.focus()})});
    (function(){var menu=document.querySelector('.site-menu');document.addEventListener('keydown',function(e){if(e.key==='Escape'&&menu.open){menu.open=false;menu.querySelector('summary').focus()}});document.addEventListener('click',function(e){if(!menu.contains(e.target))menu.open=false});var select=document.getElementById('public-theme');select.parentElement.hidden=false;try{var saved=localStorage.getItem('public-theme');if(saved)select.value=saved}catch(e){}var system=matchMedia('(prefers-color-scheme:dark)');function apply(){document.documentElement.dataset.theme=select.value==='system'?(system.matches?'dark':'light'):select.value}select.addEventListener('change',function(){try{localStorage.setItem('public-theme',select.value)}catch(e){}apply()});system.addEventListener('change',function(){if(select.value==='system')apply()})})();</script>
    </body></html>`;
}
