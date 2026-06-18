# PostStack — Landing Page

Premium, source-available marketing site for **PostStack** (self-hosted Facebook & Instagram
management).

This is **not a separate deployment**. The Astro site is built into the PostStack Docker image
(`docker/Dockerfile`, `landing` stage) and the Hono app serves it at `/` (feature **LANDING1**,
`src/server/routes/landing.ts`): anonymous visitors get the marketing page, logged-in visitors are
redirected to the panel. Same image, same container, same domain as the app
(`https://poststack.techskills.academy/`).

## Stack

| Layer | Choice |
|-------|--------|
| Framework | Astro 5 (`output: static`) |
| Styling | Tailwind CSS v4 (CSS-first `@theme` tokens) |
| Motion | Lenis + GSAP ScrollTrigger (lazy-loaded, reduced-motion aware) |
| Fonts | Self-hosted via `@fontsource-variable` (Plus Jakarta Sans, Inter, JetBrains Mono) |
| Hosting | Built into the PostStack Docker image; served by the Hono app at `/` |

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

## Build & deploy

There is no standalone deploy for this site. It ships with the app:

1. `docker/Dockerfile` builds it in an isolated `landing` stage (`npm run build` → `dist/`), so its
   dev-deps (Astro, Tailwind) never reach the runtime image.
2. `COPY --from=landing /landing/dist ./landing/dist` puts the static output next to the app.
3. The Hono app serves it at `/` and `/_astro/*` (`src/server/ui/landing.ts`, root = `landing/dist`).

So a normal PostStack release (tag → CI builds the GHCR image → deploy) ships the latest landing.
Nothing to point at Cloudflare Pages.

## Analytics & cookie consent (env)

The footer carries a cookie-consent manager + "Cookies"/"Privacy" links (see `Analytics.astro` and
`src/lib/cookieconsent-init.ts`). Tracking is **off** unless these `PUBLIC_*` vars are present at
**build time** (Astro inlines them; the build runs in the Docker `landing` stage, i.e. in CI):

| Var | Purpose |
|-----|---------|
| `PUBLIC_UMAMI_WEBSITE_ID` | Umami site id → cookieless analytics (server at `stats.techskills.academy`) |
| `PUBLIC_UMAMI_SRC` | optional; defaults to `https://stats.techskills.academy/script.js` |
| `PUBLIC_GTM_ID` | `GTM-XXXXXXX` → GA4 + Meta via server-side GTM (needs sGTM at `t.poststack.techskills.academy`) |

These are public (non-secret) values. They flow: **repo Variables → `release.yml` build job
`build-args` → `Dockerfile` `landing` stage `ARG`/`ENV` → `npm run build`.** Set the repo Variables,
cut a release, and analytics is baked into the served HTML. Without them the build stays green and the
consent UI still works — it just doesn't load any tracker.

## Assets

- `public/og.png` (1200×630) and `public/favicon.svg` are committed. Regenerate the OG image
  from `/tmp/og.svg` via `sharp` if branding changes.
- No raster images on the page itself (gradients/CSS only) → strong LCP/Lighthouse.
