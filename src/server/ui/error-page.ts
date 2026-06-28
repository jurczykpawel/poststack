import { html } from "hono/html";
import { doc } from "./layout";
import { icon } from "./components/icons";

type Html = ReturnType<typeof html>;

/** Branded full-page error (404/500) on the panel design system. Rendered for HTML page routes; API
 *  routes keep the JSON { data, error } contract. Inherits the user's theme via the boot script. */
export function errorPage(code: 404 | 500): Html {
  const is404 = code === 404;
  const title = is404 ? "Page not found" : "Something went wrong";
  const body = is404
    ? "The page you're looking for doesn't exist or may have moved."
    : "An unexpected error happened on our end. Please try again in a moment.";
  return doc(
    `${code} · PostStack`,
    html`<main class="errpage">
      <div class="errpage-card">
        <div class="errpage-code">${code}</div>
        <h1 class="errpage-title">${title}</h1>
        <p class="errpage-body">${body}</p>
        <div class="errpage-actions">
          <a class="btn btn-primary" href="/overview">${icon("dashboard", "ico", 15)} Back to dashboard</a>
          <a class="btn btn-ghost" href="/">Home</a>
        </div>
      </div>
    </main>`,
  );
}
