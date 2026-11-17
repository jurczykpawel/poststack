import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRAND, withBrand } from "@/lib/brand";
vi.hoisted(() => {
  Object.assign(process.env, { DATABASE_URL: "postgres://test:test@localhost:5433/test", JWT_SECRET: "test-secret-at-least-32-characters-long", ENCRYPTION_KEY: "test-encryption-key-at-least-32-characters", APP_URL: "http://localhost:3000", CRON_SECRET: "test-cron-secret-at-least-32-characters" });
});
vi.mock("@/lib/auth", () => ({ authenticate: vi.fn(async () => null) }));
vi.mock("@/lib/settings/config", () => ({ getConfig: vi.fn(async () => "") }));
import { landingRoutes } from "../../routes/landing";
const paths = ["/", "/how-it-works", "/features", "/faq", "/about", "/contact", "/privacy", "/terms", "/data-deletion"];
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
beforeEach(async () => {
  const { getConfig } = await import("@/lib/settings/config");
  vi.mocked(getConfig).mockResolvedValue("");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("instance public pages", () => {
  it("serves distinct, substantive pages with complete navigation and reachable links", async () => {
    const mains = new Set<string>();
    for (const path of paths) {
      const res = await landingRoutes.request(path);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body.match(/<h1[ >]/g), path).toHaveLength(1);
      const main = text(body.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "");
      expect(main.length, path).toBeGreaterThan(900);
      mains.add(main);
      expect(main, path).not.toMatch(/No response deadline|not a claim of endorsement/i);
      for (const tag of ["header", "footer"]) {
        const part = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
        for (const link of paths) expect(part, `${path} ${tag}`).toContain(`href="${link}"`);
      }
      expect(body).toContain('href="/login">Open the app');
      expect(body).not.toContain(DEFAULT_BRAND.contactEmail);
      expect(text(body.replace(/<script[\s\S]*?<\/script>/g, ""))).not.toMatch(/self-?host|open-?source|white-?label|fork the|postiz|\/token|license|founded|since 20\d\d|team of|employees|headquarter/i);
      for (const [, href] of body.matchAll(/href="(\/[^"#]*)"/g)) {
        if (href === "/login" || /\.(css|svg)$/.test(new URL(href, "http://localhost").pathname)) continue;
        expect((await landingRoutes.request(href)).status, href).toBe(200);
      }
    }
    expect(mains.size).toBe(paths.length);
  });
  it("shows the configured standard operator contact only on the contact page", async () => {
    vi.stubEnv("OPERATOR_EMAIL", "operator@example.com");
    const body = await (await landingRoutes.request("/contact")).text();
    expect(body).toContain('operator [at] example [dot] com');
    expect(body).toContain('data-contact="' + Array.from("operator@example.com", c => c.codePointAt(0)).join(",") + '"');
    expect(body).not.toContain('kontakt [at] techskills');
    for (const path of ["/privacy", "/terms", "/data-deletion"]) {
      const page = await (await landingRoutes.request(path)).text();
      expect(page).toContain('href="/contact"');
      expect(page).not.toContain('operator [at]');
    }
  });
  it("asks visitors to contact their administrator when no operator email is configured", async () => {
    vi.stubEnv("OPERATOR_EMAIL", undefined);
    const body = await (await landingRoutes.request("/contact")).text();
    expect(body).toContain("contact the administrator of this instance");
    expect(body).not.toContain("data-contact=");
    expect(body).not.toContain("kontakt [at]");
  });
  it("keeps the white-label contact independent of the standard operator email", async () => {
    for (const email of [undefined, "operator@example.com"]) {
      vi.stubEnv("OPERATOR_EMAIL", email);
      const body = await withBrand({ ...DEFAULT_BRAND, name: "Orchard", contactEmail: "help@orchard.example" }, async () => (await landingRoutes.request("/contact")).text());
      expect(body).toContain("help [at] orchard [dot] example");
      expect(body).not.toContain("operator [at]");
      expect(body).not.toContain("contact the administrator of this instance");
    }
  });
  it("uses instance identity and omits integrations without credentials", async () => {
    const body = await withBrand({ ...DEFAULT_BRAND, name: 'Orchard <Studio>', contactEmail: 'help@orchard.example', publicUrl: 'https://orchard.example' }, async () => (await landingRoutes.request('/features')).text());
    expect(body).toContain('Orchard &lt;Studio&gt;');
    expect(body).toContain('http://localhost:3000/features');
    expect(body).not.toContain('PostStack');
    expect(body).not.toMatch(/TikTok|Facebook|Instagram|YouTube|LinkedIn|Gmail|Threads/);
    expect(body).toContain('Telegram');
    expect(body).not.toContain('help@orchard.example');
  });
  it("derives enabled publisher permissions from its configuration", async () => {
    const { getConfig } = await import('@/lib/settings/config');
    vi.mocked(getConfig).mockImplementation(async key => key === 'TIKTOK_CLIENT_KEY' || key === 'TIKTOK_CLIENT_SECRET' ? 'configured' : '');
    const body = await (await landingRoutes.request('/features')).text();
    expect(body).toContain('TikTok');
    expect(body).toContain('video.publish');
    expect(body).toContain('Upload to inbox');
    expect(body).toContain('Direct Post');
  });
  it("shows TikTok permissions and omits incomplete connections", async () => {
    const { getConfig } = await import("@/lib/settings/config");
    vi.mocked(getConfig).mockResolvedValue("configured-value");
    let body = await (await landingRoutes.request("/features")).text();
    for (const label of ["Facebook", "Instagram", "YouTube", "TikTok", "Threads", "LinkedIn", "X"]) expect(body).toContain(label);
    for (const scope of ["user.info.basic", "video.upload", "video.publish"]) expect(body).toContain(scope);
    for (const scope of ["pages_show_list", "instagram_business_basic", "threads_basic", "w_member_social", "tweet.write"]) expect(body).not.toContain(scope);
    expect(body).not.toContain("configured-value");
    vi.mocked(getConfig).mockImplementation(async key => key.endsWith("SECRET") ? "" : "id-only");
    body = await (await landingRoutes.request("/features")).text();
    expect(body).not.toMatch(/Facebook|Instagram|YouTube|TikTok|Threads|LinkedIn/);
  });
  it("includes the configured Google comment connection", async () => {
    const { getConfig } = await import('@/lib/settings/config');
    vi.mocked(getConfig).mockImplementation(async key => key === 'GOOGLE_CLIENT_ID' || key === 'GOOGLE_CLIENT_SECRET' ? 'configured-google' : '');
    const body = await (await landingRoutes.request('/features')).text();
    expect(body).toContain('YouTube');
    expect(body).not.toContain('youtube.force-ssl');
    expect(body).not.toContain('configured-google');
  });
  it("describes configured history compaction without promising total erasure", async () => {
    vi.stubEnv("HISTORY_RETENTION_DAYS", "90");
    expect(await (await landingRoutes.request("/privacy")).text()).toContain("90-day history compaction window");
    vi.stubEnv("HISTORY_RETENTION_DAYS", "0");
    expect(await (await landingRoutes.request("/privacy")).text()).toContain("Automatic history compaction is disabled");
  });
  it("keeps paragraphs unique across public pages in every configuration", async () => {
    const { getConfig } = await import("@/lib/settings/config");
    for (const configured of [false, true]) {
      vi.mocked(getConfig).mockResolvedValue(configured ? "configured" : "");
      const seen = new Map<string, string>();
      for (const path of paths) {
        const body = await (await landingRoutes.request(path)).text();
        const main = body.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
        for (const [paragraph] of main.matchAll(/<p[ >][\s\S]*?<\/p>/g)) {
          const value = text(paragraph);
          if (value.length <= 80) continue;
          expect(seen.get(value), `${path}: ${value}`).toBeUndefined();
          seen.set(value, path);
        }
        if (path !== "/contact") expect(body).not.toContain('data-contact=');
        if (path !== "/features") expect(body).not.toContain('Configured connections');
        if (path !== "/how-it-works") expect(body).not.toContain('<h2>Scheduling and your approval</h2>');
        if (path !== "/privacy") expect(body).not.toContain('History and retention');
      }
    }
  });
  it("describes TikTok data and controls only for configured instances", async () => {
    expect(await (await landingRoutes.request("/privacy")).text()).not.toContain("TikTok");
    const { getConfig } = await import("@/lib/settings/config");
    vi.mocked(getConfig).mockResolvedValue("configured");
    const privacy = await (await landingRoutes.request("/privacy")).text();
    for (const value of ["TikTok data", "open_id", "display_name", "refresh", "60 seconds", "Settings and privacy", 'href="/data-deletion"']) expect(privacy).toContain(value);
    expect(await (await landingRoutes.request("/terms")).text()).toContain("Music Usage Confirmation");
    expect(await (await landingRoutes.request("/data-deletion")).text()).toContain("Settings and privacy");
    const home = await (await landingRoutes.request("/")).text();
    expect(home).toMatch(/<img[^>]+src="\/public-compose-tiktok.webp"[^>]+width="\d+"[^>]+height="\d+"[^>]+alt="[^"]+"/);
  });
  it("uses APP_URL for canonical, social and discovery addresses", async () => {
    for (const origin of ["https://preview.example", "https://publisher.example/"]) {
      vi.stubEnv("APP_URL", origin);
      const base = origin.replace(/\/$/, "");
      const body = await (await landingRoutes.request("/features")).text();
      expect(body).toContain(`<link rel="canonical" href="${base}/features"`);
      expect(body).toContain(`<meta property="og:url" content="${base}/features"`);
      expect(await (await landingRoutes.request("/sitemap-0.xml")).text()).toContain(`<loc>${base}/features</loc>`);
      expect(await (await landingRoutes.request("/robots.txt")).text()).toContain(`Sitemap: ${base}/sitemap-index.xml`);
    }
  });
  it("keeps the authenticated home redirect", async () => {
    const { authenticate } = await import('@/lib/auth');
    vi.mocked(authenticate).mockResolvedValueOnce({ userId: 'u', workspaceId: 'w', scopes: [], authMethod: 'session' });
    const res = await landingRoutes.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/overview');
  });
});
