# PostStack — Landing Page

Premium, source-available marketing site for **PostStack** (self-hosted Facebook & Instagram
management). Deploys independently from the Hono app.

- **Marketing site:** `https://poststack.techskills.academy/` (this package → Cloudflare Pages)
- **App:** `https://app.poststack.techskills.academy/` (the Hono dashboard, separate deploy)

## Stack

| Layer | Choice |
|-------|--------|
| Framework | Astro 5 (`output: static`) |
| Styling | Tailwind CSS v4 (CSS-first `@theme` tokens) |
| Motion | Lenis + GSAP ScrollTrigger (lazy-loaded, reduced-motion aware) |
| Fonts | Self-hosted via `@fontsource-variable` (Plus Jakarta Sans, Inter, JetBrains Mono) |
| Hosting | Cloudflare Pages |

## Editing content

**All copy lives in one file:** [`src/content/landing.ts`](src/content/landing.ts).
Add/remove capability cards, FAQ entries, pricing tiers, nav links, the scroll-story scenes,
and the footer there — no component changes needed.

Testimonials are off until real quotes exist: set `testimonialModule.enabled = true` in the
same file. While disabled, the section shows honest trust-signal stats instead of fake reviews.

## Structure

```
src/
├── content/landing.ts      # single source of truth for ALL copy/content
├── styles/global.css       # Tailwind v4 @theme design tokens + base/components
├── scripts/motion.ts       # scroll reveals, sticky nav, GSAP pin/scrub, Lenis
├── layouts/BaseLayout.astro # <head>, SEO/OG, JSON-LD, skip link, fail-safe reveal
├── components/             # one file per section (Nav, Hero, ScrollStory, …)
└── pages/
    ├── index.astro         # composes the sections
    ├── robots.txt.ts       # generated
    └── llms.txt.ts         # generated (agent-ready)
```

## Signature scroll-driven moment

`ScrollStory.astro` pins "the PostStack loop" and scrubs through **Capture → Convert → Nurture**
(comment → comment-to-DM → drip sequence + CRM) as the user scrolls — feature-grounded, not a
generic effect. On mobile and under `prefers-reduced-motion` the three scenes simply stack.

## Develop

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # astro check (type-check) + static build → dist/
npm run preview
```

## Deploy (Cloudflare Pages)

- **Root directory:** `landing`
- **Build command:** `npm run build`
- **Output directory:** `dist`
- Point `poststack.techskills.academy` at the Pages project; `app.` stays on the Hono app.

## Assets

- `public/og.png` (1200×630) and `public/favicon.svg` are committed. Regenerate the OG image
  from `/tmp/og.svg` via `sharp` if branding changes.
- No raster images on the page itself (gradients/CSS only) → strong LCP/Lighthouse.
