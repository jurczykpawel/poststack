import { Hono } from "hono";
import { authenticate } from "@/lib/auth";
import { serveLandingFile } from "../ui/landing";

// Public marketing homepage. The built Astro site (landing/dist) is served at `/` and its assets.
// LANDING1: `/` shows the landing to logged-out visitors (the public face of the product), while a
// logged-in visitor is sent straight to the panel — same as the pre-landing home behaviour.
export const landingRoutes = new Hono();

// Root assets Astro emits next to index.html (single-page marketing site). _astro/* is fingerprinted.
const ROOT_FILES = ["favicon.svg", "og.png", "robots.txt", "llms.txt", "sitemap-index.xml", "sitemap-0.xml"];

landingRoutes.get("/", async (c) => {
  const auth = await authenticate(c.req.raw).catch(() => null);
  if (auth) return c.redirect("/overview");
  return serveLandingFile(c, "index.html");
});

landingRoutes.get("/_astro/*", (c) => serveLandingFile(c, c.req.path.replace(/^\//, "")));

for (const f of ROOT_FILES) {
  landingRoutes.get(`/${f}`, (c) => serveLandingFile(c, f));
}
