import { Hono } from "hono";
import { authenticate } from "@/lib/auth";
import { serveAsset } from "../ui/assets";
import { serveLandingFile } from "../ui/landing";

import { PUBLIC_PAGES } from "../ui/public-site/pages";
import { renderPublicPage } from "../ui/public-site/site";

export const landingRoutes = new Hono();
for (const page of PUBLIC_PAGES) {
  const handler = async (c: import("hono").Context) => {
    if (page.path === "/") {
      const auth = await authenticate(c.req.raw).catch(() => null);
      if (auth) return c.redirect("/overview");
    }
    c.header("Cache-Control", "private, no-store");
    return c.html(await renderPublicPage(page));
  };
  landingRoutes.get(page.path, handler);
  if (page.path !== "/") landingRoutes.get(`${page.path}/`, handler);
}

landingRoutes.get("/static/public-site/:file", c => serveAsset(c, `public-site/${c.req.param("file")}`));

landingRoutes.get("/_astro/*", (c) => serveLandingFile(c, c.req.path.replace(/^\//, "")));

// Root-level static assets Astro emits next to index.html — favicon, og image, the hero/showcase
// imagery, robots/sitemap/llms. Matched generically by extension (single path segment only) so a
// newly-added asset never needs a code change. serveLandingFile still guards path traversal,
// allowlists the extension, and 404s anything not present in the build. `html` is deliberately
// excluded so `/` keeps its logged-in→/overview redirect (no direct /index.html bypass).
landingRoutes.get(
  "/:file{.+\\.(?:webp|png|jpe?g|svg|ico|gif|webmanifest|xml|txt|json)}",
  (c) => serveLandingFile(c, c.req.param("file")),
);
