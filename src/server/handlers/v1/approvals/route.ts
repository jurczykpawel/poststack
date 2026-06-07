import { and, eq, desc } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { pendingApprovals } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/v1/approvals?status=pending — list parked replies awaiting human review
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "conversations:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) return ApiErrors.validationError(parsed.error.flatten().fieldErrors);

  const rows = await db.query.pendingApprovals.findMany({
    where: and(
      eq(pendingApprovals.workspace_id, auth.workspaceId),
      eq(pendingApprovals.status, parsed.data.status),
    ),
    orderBy: desc(pendingApprovals.created_at),
    limit: parsed.data.limit,
    columns: {
      id: true,
      rule_id: true,
      conversation_id: true,
      contact_id: true,
      channel_id: true,
      recipient_platform_id: true,
      proposed_content: true,
      status: true,
      created_at: true,
      resolved_at: true,
    },
  });

  return ok(rows);
}
