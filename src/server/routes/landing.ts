import { Hono } from "hono";
import { authenticate } from "@/lib/auth";
import { serveLandingFile } from "../ui/landing";

// Public marketing homepage. The built Astro site (landing/dist) is served at `/` and its assets.
// LANDING1: `/` shows the landing to logged-out visitors (the public face of the product), while a
// logged-in visitor is sent straight to the panel — same as the pre-landing home behaviour.
export const landingRoutes = new Hono();

landingRoutes.get("/", async (c) => {
  const auth = await authenticate(c.req.raw).catch(() => null);
  if (auth) return c.redirect("/overview");
  return serveLandingFile(c, "index.html");
});

// Static marketing sub-pages (Astro emits <page>/index.html). Public, no auth redirect.
landingRoutes.get("/privacy", (c) => serveLandingFile(c, "privacy/index.html"));
landingRoutes.get("/privacy/", (c) => serveLandingFile(c, "privacy/index.html"));

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
