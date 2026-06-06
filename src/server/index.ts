import { serve } from "@hono/node-server";
import { buildApp } from "./app";

const port = Number(process.env.PORT) || 3000;

serve({ fetch: buildApp().fetch, port }, (info) => {
  console.log(`[server] ReplyStack listening on http://localhost:${info.port}`);
});
