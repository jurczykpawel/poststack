import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_PAGES } from "../src/server/ui/public-site/pages";
import { locale } from "../src/server/ui/public-site/locales/en";

// Titles share their source with the SSR pages. These cards describe the page, not the operator.
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
if (!process.env.FONTCONFIG_FILE) {
  const temporary = await mkdtemp(join(tmpdir(), "public-site-fonts-"));
  const config = join(temporary, "fonts.conf");
  await writeFile(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${escape(join(process.cwd(), "src/server/ui/static/public-site"))}</dir><cachedir>${escape(temporary)}</cachedir></fontconfig>`);
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [import.meta.filename], { env: { ...process.env, FONTCONFIG_FILE: config }, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
} else {
  const { default: sharp } = await import("sharp");
  const logo = await sharp("landing/public/favicon.svg", { density: 288 }).resize(64, 64).png().toBuffer();
  await sharp("landing/public/favicon.svg", { density: 2304 }).resize(1024, 1024).png().toFile("landing/public/poststack-icon-1024.png");
  for (const page of PUBLIC_PAGES) {
    const title = await sharp({ text: { text: `<span foreground="#2A5BC2">${escape(page.title)}</span>`, font: "Geologica 68", fontfile: join(process.cwd(), "src/server/ui/static/public-site/geologica-var.woff2"), width: 1000, rgba: true } }).png().toBuffer();
    const caption = await sharp({ text: { text: `<span foreground="#55556A">// ${escape(locale.signature)}</span>`, font: "Source Sans 3 28", fontfile: join(process.cwd(), "src/server/ui/static/public-site/source-sans-3-var.woff2"), rgba: true } }).png().toBuffer();
    await sharp({ create: { width: 1200, height: 630, channels: 4, background: "#F5F5F0" } })
      .composite([{ input: logo, left: 80, top: 80 }, { input: title, left: 80, top: 220 }, { input: caption, left: 168, top: 100 }])
      .png().toFile(`landing/public/public-site-${page.path.slice(1) || "home"}.png`);
  }
}
