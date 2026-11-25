import { BRAND } from "@/lib/brand";
import { html } from "hono/html";
import { getInstanceLicense } from "@/lib/license/gate";
import { doc, renderPage } from "./layout";
import { icon } from "./components/icons";

type Html = ReturnType<typeof html>;

function errorContent(code: 403 | 404 | 500, message?: string, showHeading = true) {
  const title = code === 403 ? "Access denied" : code === 404 ? "Page not found" : "Something went wrong";
  const body = message ?? (code === 403 ? "You don’t have permission to open this page."
    : code === 404 ? "The page you’re looking for doesn’t exist or may have moved."
      : "An unexpected error happened on our end. Please try again in a moment.");
  return { title, content: html`<div class="errpage-card">
    <div class="errpage-code">${code}</div>
    ${showHeading ? html`<h1 class="errpage-title">${title}</h1>` : ""}
    <p class="errpage-body">${body}</p>
    <div class="errpage-actions">
      <a class="btn btn-primary" href="/overview">${icon("dashboard", "ico", 15)} Back to dashboard</a>
      <a class="btn btn-ghost" href="/">Home</a>
    </div>
  </div>` };
}

export function errorPage(code: 404 | 500): Html {
  return doc(`${code} · ${BRAND.name}`, html`<main class="errpage">${errorContent(code).content}</main>`);
}

export async function panelErrorPage(code: 403 | 404, message?: string): Promise<Html> {
  const { title, content } = errorContent(code, message, false);
  const { features, products } = await getInstanceLicense();
  return renderPage({ title, nav: "", body: html`<div class="errpage">${content}</div>`, features, products });
}
