import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountSources, channels } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { connectAccountSource } from "@/lib/channels/account-source";
import { MetaTokenError } from "@/lib/platforms/meta-token";

export const runtime = "nodejs";

const connectSchema = z.object({ token: z.string().min(20) });

// GET /api/v1/sources — list managed connections + their derived channels.
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "sources:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("managed_connection");
  if (gate) return gate;

  const sources = await db.query.accountSources.findMany({
    where: eq(accountSources.workspace_id, auth.workspaceId),
    columns: {
      id: true, provider: true, provider_account_id: true, display_name: true, kind: true,
      status: true, needs_reauth_reason: true, data_access_expires_at: true, last_synced_at: true, metadata: true,
    },
  });

  const sourceIds = sources.map((s) => s.id);
  const derived = sourceIds.length
    ? await db.query.channels.findMany({
        where: and(eq(channels.workspace_id, auth.workspaceId), inArray(channels.source_id, sourceIds)),
        columns: {
          id: true, source_id: true, platform: true, platform_id: true, display_name: true,
          username: true, profile_picture: true, status: true, token_expires_at: true, data_access_expires_at: true,
        },
      })
    : [];

  return ok(
    sources.map((s) => ({
      ...s,
      scopes: (s.metadata as { scopes?: string[] }).scopes ?? [],
      channels: derived
        .filter((c) => c.source_id === s.id)
        .map(({ source_id: _omit, ...c }) => c),
    })),
  );
}

// POST /api/v1/sources — connect (or reconnect) a managed connection from a pasted master token.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "sources:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("managed_connection");
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error.flatten().fieldErrors);

  let result;
  try {
    result = await connectAccountSource(auth.workspaceId, parsed.data.token);
  } catch (err) {
    if (err instanceof MetaTokenError) return ApiErrors.badRequest(err.message);
    return ApiErrors.badRequest("Could not connect this token — check it and its permissions");
  }

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelConnected,
    targetType: "account_source",
    targetId: result.sourceId,
    metadata: { mode: "managed", kind: result.kind, connected: result.connected, by_platform: result.byPlatform },
  });

  return created({ source_id: result.sourceId, kind: result.kind, connected: result.connected, by_platform: result.byPlatform });
}
