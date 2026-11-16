import { html } from "hono/html";
import { currentBrand, isWhiteLabel } from "@/lib/brand";
import { brandingHead, brandLogo } from "../branding";
import { assetUrl } from "../assets";
import { PUBLIC_PAGES, publicSiteOrigin, type PublicPage } from "./pages";
import { publicSiteConfig } from "./config";
import { publicContent } from "./content";

export async function renderPublicPage(page: PublicPage) {
  const brand = currentBrand();
  const origin = publicSiteOrigin();
  const config = await publicSiteConfig();
  const nav = () => PUBLIC_PAGES.map(p => html`<a href="${p.path}" aria-current="${p.path === page.path ? "page" : "false"}">${p.label}</a>`);
  return html`<!doctype html><html lang="en" data-theme="${brand.theme}"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${page.title} · ${brand.name}</title><meta name="description" content="${page.title}: publishing, connected accounts and service information for ${brand.name}." />
    <link rel="canonical" href="${origin}${page.path}" />
    <meta property="og:title" content="${page.title} · ${brand.name}" /><meta property="og:description" content="Service information for the ${brand.name} instance." /><meta property="og:type" content="website" /><meta property="og:url" content="${origin}${page.path}" />
    <link rel="stylesheet" href="${assetUrl("tokens.css")}" />${brandingHead()}
    <style>
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text-1);font-family:var(--font-sans,system-ui,sans-serif);line-height:1.7;overflow-wrap:anywhere}
    a{color:var(--accent);text-underline-offset:.22em}a:hover{text-decoration-thickness:2px}a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
    .skip{position:absolute;left:1rem;top:-8rem}.skip:focus{top:1rem;background:var(--bg);z-index:1;padding:.6rem}
    header,footer{padding:1.5rem max(1.25rem,calc((100vw - 76rem)/2));border-bottom:1px solid var(--border)}
    .masthead{display:flex;align-items:center;justify-content:space-between;gap:1rem}.identity{display:flex;align-items:center;gap:.75rem;font-weight:700;color:var(--text-1);text-decoration:none;font-size:1.2rem}.brand-glyph{display:grid;place-items:center;width:2rem;height:2rem;background:var(--accent);color:var(--accent-contrast);border-radius:.5rem}
    nav{display:flex;flex-wrap:wrap;gap:.4rem 1.3rem;margin-top:1.25rem}nav a{font-size:.9rem;color:var(--text-2);padding:.3rem 0;text-decoration:none}nav a[aria-current=page]{color:var(--text-1);text-decoration:underline;text-decoration-color:var(--accent);text-decoration-thickness:2px}
    .app-link{border:1px solid var(--border);border-radius:.5rem;padding:.6rem 1rem;white-space:nowrap;color:var(--text-1);font-weight:600;text-decoration:none}
    main{max-width:76rem;margin:0 auto;padding:3.5rem 1.25rem 5rem}.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:.75rem;color:var(--accent);font-weight:700}h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.13;letter-spacing:-.035em;max-width:22ch;margin:.7rem 0 1.5rem}h2{font-size:1.35rem;line-height:1.3;margin:0 0 1rem}h3{font-size:1rem;margin:0 0 .6rem}p{max-width:78ch;margin:.8rem 0}.lead{font-size:1.2rem;color:var(--text-2);margin-bottom:2.5rem;max-width:60ch}
    main>section{border-top:1px solid var(--border);padding-top:1.8rem;margin-top:2rem}.integration-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1rem;margin:1.5rem 0}.integration{border:1px solid var(--border);border-radius:.75rem;padding:1.25rem}.integration p{font-size:.9rem;color:var(--text-2)}.scopes{font-family:monospace;font-size:.85em}.contact-email{font:inherit;color:var(--accent);border:0;background:transparent;padding:0;text-decoration:underline;cursor:pointer}
    figure{margin:2rem 0}figure img{display:block;width:100%;max-width:42rem;height:auto;border:1px solid var(--border);border-radius:.75rem}figcaption{color:var(--text-2);font-size:.9rem;margin-top:.75rem}
    footer{border-top:1px solid var(--border);border-bottom:0;padding-bottom:2.5rem;color:var(--text-2)}footer p{font-size:.9rem}footer nav{margin-top:.75rem}
    @media(max-width:600px){header,footer{padding:1.25rem}.masthead{align-items:flex-start}.identity{font-size:1rem}.app-link{font-size:.85rem;padding:.5rem .7rem}nav{gap:.25rem 1rem}main{padding-top:2rem}h1{max-width:100%}}
    </style></head><body><a class="skip" href="#main">Skip to content</a>
    <header><div class="masthead"><a class="identity" href="/">${brandLogo()}<span>${brand.name}</span></a><a class="app-link" href="/login">Open the app</a></div><nav aria-label="Main">${nav()}</nav></header>
    <main id="main"><p class="eyebrow">${brand.name} / ${page.label}</p><h1>${page.title}</h1>${publicContent(page, config)}</main>
    <footer><strong>${brand.name}</strong><p>${brand.footer}</p><nav aria-label="Footer">${nav()}</nav>${!isWhiteLabel() ? html`<p><a href="https://techskills.academy">TechSkills Academy</a></p>` : ""}</footer>
    <script>document.querySelectorAll('[data-contact]').forEach(function(button){button.addEventListener('click',function(){var email=button.dataset.contact.split(',').map(function(n){return String.fromCodePoint(Number(n))}).join('');var link=document.createElement('a');link.href='mailto:'+email;link.textContent=email;button.replaceWith(link);link.focus()})});</script>
    </body></html>`;
}
