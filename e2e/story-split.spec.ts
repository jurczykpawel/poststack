import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Compose says a long Instagram Story video will be published as several Stories", async ({ page }, info) => {
  const directory = mkdtempSync(join(tmpdir(), "story-split-e2e-"));
  try {
    const file = join(directory, "long.webm");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=90x160:r=24", "-t", "125", "-c:v", "libvpx", "-b:v", "50k", "-deadline", "realtime", "-cpu-used", "8", file]);
    const video = readFileSync(file);
    await page.route("https://cdn.example.test/**", route => route.fulfill({ status: 200, contentType: "video/webm", body: video }));

    await page.goto("/compose");
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    await page.getByLabel("Media URL", { exact: true }).fill("https://cdn.example.test/long.webm");
    const contentType = page.locator("label.fld").filter({ has: page.locator("select[aria-label='Content type']") });
    await contentType.locator("button.ps-trigger").click();
    await page.getByRole("option", { name: "Story", exact: true }).click();

    const notice = page.locator("[data-story-split]");
    await expect(notice).toHaveText("Video is 125 s — on Instagram it will be published as 3 Stories of up to 60 s, one after another.");
    await page.screenshot({ path: info.outputPath("story-split-notice.png"), fullPage: true });
    await page.locator(".target").filter({ hasText: "Instagram" }).click();
    await expect(notice).toBeHidden();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
