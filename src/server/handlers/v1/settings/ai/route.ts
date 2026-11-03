import { z } from "zod";
import { authenticateInstanceScope } from "@/lib/auth/instance-operator";
import { ok, err, ApiErrors } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/body-limit";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { AI_PROVIDER_IDS } from "@/lib/ai/providers";
import { aiSettingsView, saveAiSettings, clearAiSettings } from "@/lib/ai/settings";

export const runtime = "nodejs";

/** Candidate fields shared by PUT, /models and /test. */
export const candidateSchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  api_key: z.string().min(1).max(500).regex(/^\S+$/, "must not contain whitespace").optional(),
  base_url: z.string().max(300).nullish().transform((v) => v || undefined),
  model: z.string().max(200).optional(),
});
const putSchema = candidateSchema.extend({ provider: z.enum(AI_PROVIDER_IDS), model: z.string().min(1).max(200), verify: z.boolean().default(true) });

// GET /api/v1/settings/ai — effective AI provider config (never the key)
export async function GET(request: Request) {
  if (!(await authenticateInstanceScope(request, "instance_ai:read"))) return ApiErrors.unauthorized();
  return ok(await aiSettingsView());
}

// PUT /api/v1/settings/ai — choose provider + model (+ key / custom URL); verifies the connection first by default
export async function PUT(request: Request) {
  const auth = await authenticateInstanceScope(request, "instance_ai:write");
  if (!auth) return ApiErrors.unauthorized();
  const body = await parseJsonBody(request, 4_096);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error);
  const result = await saveAiSettings(parsed.data);
  if (!result.ok) return err(result.code, result.message, result.status, result.details);
  await recordAudit({ workspaceId: auth.workspaceId, actor: actorFromAuth(auth), action: AuditAction.AiSettingsUpdated, metadata: { provider: parsed.data.provider, model: parsed.data.model, key_changed: result.keyChanged } });
  return ok(await aiSettingsView());
}

// DELETE /api/v1/settings/ai — remove the values stored here (environment values apply again)
export async function DELETE(request: Request) {
  const auth = await authenticateInstanceScope(request, "instance_ai:write");
  if (!auth) return ApiErrors.unauthorized();
  await clearAiSettings();
  await recordAudit({ workspaceId: auth.workspaceId, actor: actorFromAuth(auth), action: AuditAction.AiSettingsCleared });
  return ok(await aiSettingsView());
}
