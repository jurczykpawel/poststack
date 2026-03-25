import { NextResponse } from "next/server";

/**
 * GET /api/docs
 * Serves Scalar API reference UI.
 * Scalar is a modern alternative to Swagger UI — no npm dep needed,
 * loaded from CDN.
 */
export async function GET() {
  const html = `<!doctype html>
<html>
  <head>
    <title>ReplyStack API Docs</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/api/v1"
      data-configuration='{"theme":"purple","layout":"modern"}'
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}
