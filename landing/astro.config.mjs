import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build
export default defineConfig({
  site: "https://poststack.techskills.academy",
  output: "static",
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    preview: { allowedHosts: ["host.docker.internal"] },
  },
});
