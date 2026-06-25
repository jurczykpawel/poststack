import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  query: z.string().max(1000),
});

// POST /api/v1/channels/:id/gmail-filter — save gmail_query for a Gmail channel
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateWithScope(request, "channels:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error);

  const [updated] = await db
    .update(channels)
    .set({ gmail_query: parsed.data.query })
    .where(and(eq(channels.id, id), eq(channels.workspace_id, auth.workspaceId)))
    .returning({ id: channels.id, gmail_query: channels.gmail_query });

  if (!updated) return ApiErrors.notFound();
  return ok(updated);
}
