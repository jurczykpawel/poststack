import type { APIRoute } from "astro";
import { site, capabilities, pricing } from "../content/landing";

export const GET: APIRoute = () => {
  const caps = capabilities.map((c) => `- ${c.kicker}: ${c.title}`).join("\n");
  const tiers = pricing.map((p) => `- ${p.name}: ${p.price} ${p.period}`.trim()).join("\n");

  const body = `# ${site.name}

> ${site.description}

## Capabilities
${caps}

## Pricing
${tiers}

## Links
- App: ${site.appUrl}
- Source: ${site.githubUrl}
- License checkout: ${site.ctaUrl}
`;

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
