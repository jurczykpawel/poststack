import { z } from "zod";
import type { Hono } from "hono";
import { authenticateInstanceScope } from "@/lib/auth/instance-operator";
import { ok, err, ApiErrors } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/body-limit";
import { rateLimit } from "@/lib/api/rate-limit";
import { providerInput, listProviders, saveProvider, removeProvider, reorderProviders, probeProvider, providerModels, migrateInstanceProviders, replaceProviders } from "@/lib/ai/provider-store";
import { AiError } from "@/lib/ai/models";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";

const entryInput = providerInput.extend({ id: z.uuid().transform(s => s.toLowerCase()).optional() });
const probeInput = entryInput.extend({ refresh: z.boolean().optional(), all: z.boolean().optional() });
export async function providerOperation(request: Request, action: "list" | "save" | "remove" | "reorder" | "replace" | "test" | "models", rawId?: string) {
  const auth = await authenticateInstanceScope(request, action === "list" ? "instance_ai:read" : "instance_ai:write");
  if (!auth) return ApiErrors.unauthorized();
  const scope = null;
  await migrateInstanceProviders();
  const parsedId = z.uuid().optional().safeParse(rawId);
  if (!parsedId.success) return ApiErrors.validationError(parsedId.error);
  const id = parsedId.data?.toLowerCase();
  if (action === "list") return ok(await listProviders(scope));
  if (["save", "replace", "test", "models"].includes(action) && !(await rateLimit(`rl:ai-providers:${auth.workspaceId}`, 30, 60)).allowed) return ApiErrors.tooManyRequests();
  if (action === "remove") await removeProvider(scope, id!);
  else {
    const body = action === "test" && id && !request.body ? {} : await parseJsonBody(request, 65_536);
    if (action === "replace") {
      const parsed = z.object({ providers: z.array(entryInput).max(1000) }).strict().safeParse(body);
      if (!parsed.success) return ApiErrors.validationError(parsed.error);
      await replaceProviders(scope, parsed.data.providers, auth.authMethod === "session" ? auth.userId : undefined);
    } else if (action === "reorder") {
      const parsed = z.object({ ids: z.array(z.uuid().transform(s => s.toLowerCase())).max(1000) }).strict().safeParse(body);
      if (!parsed.success) return ApiErrors.validationError(parsed.error);
      await reorderProviders(scope, parsed.data.ids);
    } else {
      const parsed = (action === "save" ? providerInput : probeInput).safeParse(body);
      if (!parsed.success) return ApiErrors.validationError(parsed.error);
      const { id: bodyId, refresh, all, ...candidate } = parsed.data as z.infer<typeof probeInput>;
      if (action === "save") {
        const saved = await saveProvider(scope, candidate, id, auth.authMethod === "session" ? auth.userId : undefined);
        await recordAudit({ workspaceId: auth.workspaceId, actor: actorFromAuth(auth), action: AuditAction.AiSettingsUpdated, metadata: { provider: saved.provider, model: saved.model, key_changed: !!candidate.api_key } });
        return ok(saved, undefined, id ? 200 : 201);
      }
      try { return ok(action === "test" ? await probeProvider(scope, candidate, id ?? bodyId) : await providerModels(scope, candidate, bodyId, { refresh, all })); }
      catch (e) { if (e instanceof AiError) return err(e.code, "Provider request failed", 422); throw e; }
    }
  }
  await recordAudit({ workspaceId: auth.workspaceId, actor: actorFromAuth(auth), action: AuditAction.AiSettingsUpdated, metadata: { operation: action } });
  return ok(await listProviders(scope));
}
export function registerProviderApi(app: Hono) {
  const path = "/settings/ai/providers";
  app.get(path, c => providerOperation(c.req.raw, "list"));
  app.put(path, c => providerOperation(c.req.raw, "replace"));
  app.post(path, c => providerOperation(c.req.raw, "save"));
  app.put(`${path}/reorder`, c => providerOperation(c.req.raw, "reorder"));
  app.post(`${path}/test`, c => providerOperation(c.req.raw, "test"));
  app.post(`${path}/models`, c => providerOperation(c.req.raw, "models"));
  app.patch(`${path}/:id`, c => providerOperation(c.req.raw, "save", c.req.param("id")));
  app.delete(`${path}/:id`, c => providerOperation(c.req.raw, "remove", c.req.param("id")));
  app.post(`${path}/:id/test`, c => providerOperation(c.req.raw, "test", c.req.param("id")));
}
