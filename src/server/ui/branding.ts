import { html, raw } from "hono/html";
import { currentBrand, isWhiteLabel } from "@/lib/brand";

export function brandLogo() {
  const brand = currentBrand();
  return brand.logoUrl
    ? html`<img src="${brand.logoUrl}" alt="${brand.name}" width="32" height="32" style="object-fit:contain" />`
    : html`<span class="brand-glyph">${(Array.from(brand.name)[0] ?? "").toUpperCase()}</span>`;
}
export function brandingHead() {
  const brand = currentBrand();
  return html`<link rel="icon" href="${isWhiteLabel() ? brand.faviconUrl || "/instance-favicon.svg" : "/favicon.svg"}" />
    <meta name="theme-color" content="${brand.accent}" />
    ${isWhiteLabel() ? html`<style>${raw(`:root[data-theme]{--accent:${brand.accent};--accent-2:${brand.accent}}.brand{overflow-wrap:anywhere}.brand img{flex-shrink:0}`)}</style>` : ""}`;
}
export function brandingFooter() {
  if (!isWhiteLabel()) return html``;
  const brand = currentBrand();
  return html`<footer style="padding:1rem;margin-bottom:4rem;text-align:center;overflow-wrap:anywhere"><p>${brand.footer}</p>
    <a href="${brand.publicUrl}">${brand.name}</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·
    <a href="mailto:${brand.contactEmail}">${brand.contactEmail}</a></footer>`;
}
export function brandingForm() {
  const brand = currentBrand();
  const fields = [
    ["name", "Product name", "text"], ["logoUrl", "Logo URL (HTTPS or local path)", "text"],
    ["faviconUrl", "Favicon URL (blank generates an icon)", "text"], ["accent", "Accent colour", "color"],
    ["contactEmail", "Contact email", "email"], ["publicUrl", "Public origin (HTTPS)", "url"],
    ["footer", "Footer text", "text"],
  ] as const;
  return html`<form hx-post="/settings/branding" hx-ext="json-enc" hx-target="#branding-msg" hx-on::before-swap="if(event.detail.xhr.status === 400) { event.detail.shouldSwap = true; event.detail.isError = false; }" class="stack" style="max-width:36rem">
    ${fields.map(([key, label, type]) => html`<label class="fld"><span>${label}</span><input name="${key}" type="${type}" value="${key === "faviconUrl" && !isWhiteLabel() ? "" : brand[key]}" ${key === "name" || key === "contactEmail" || key === "publicUrl" ? raw("required") : ""} /></label>`)}
    <label class="fld"><span>Default theme</span><select name="theme"><option value="dark" ${brand.theme === "dark" ? raw("selected") : ""}>Dark</option><option value="light" ${brand.theme === "light" ? raw("selected") : ""}>Light</option></select></label>
    <button class="btn btn-primary" type="submit">Save instance branding</button><p id="branding-msg" role="status"></p>
  </form><form hx-post="/settings/branding" hx-ext="json-enc" hx-target="#branding-msg" hx-vals='{"reset":true}' style="margin-top:1rem">
    <button class="btn btn-ghost" type="submit">Reset stored branding</button>
  </form>`;
}
