import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoReplyRules } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";
import { createRuleSchema } from "../route";

export const runtime = "nodejs";

const RULE_COLUMNS = {
  id: true,
  name: true,
  channel_id: true,
  is_active: true,
  priority: true,
  trigger_type: true,
  trigger_config: true,
  response_type: true,
  response_config: true,
  cooldown_seconds: true,
  max_sends_per_contact: true,
  requires_approval: true,
  created_at: true,
  updated_at: true,
} as const;

// GET /api/v1/rules/:ruleId
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const rule = await db.query.autoReplyRules.findFirst({
    where: and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)),
    columns: RULE_COLUMNS,
  });
  if (!rule) return ApiErrors.notFound();
  return ok(rule);
}

/** Order-insensitive structural equality. Used to compare a rule value pulled from a Postgres
 *  `jsonb` column (which canonicalizes object key order) against the same value carried in a
 *  request body (client key order) — a plain JSON.stringify would falsely differ on key order and
 *  wrongly flag an unchanged object-valued field as edited. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().min(0).max(999).optional(),
  trigger_type: z
    .enum(["keyword", "comment_keyword", "postback", "welcome", "default", "story_reply", "story_mention", "reaction"])
    .optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
  response_type: z.enum(["text", "random_text", "ai_rephrase", "none", "follow_gate"]).optional(),
  response_config: z.record(z.string(), z.unknown()).optional(),
  cooldown_seconds: z.number().int().min(0).optional(),
  max_sends_per_contact: z.number().int().min(1).max(1_000_000).nullable().optional(),
  requires_approval: z.boolean().optional(),
});

// PATCH /api/v1/rules/:ruleId
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const existing = await db.query.autoReplyRules.findFirst({
    where: and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)),
    columns: {
      id: true,
      name: true,
      channel_id: true,
      priority: true,
      trigger_type: true,
      trigger_config: true,
      response_type: true,
      response_config: true,
      cooldown_seconds: true,
      max_sends_per_contact: true,
      requires_approval: true,
    },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  // PATCH replaces whole columns (no deep merge), so validate the EFFECTIVE rule —
  // existing values with the patch laid over them — against the same schema the
  // create path uses. This catches a PATCH that would leave the rule incomplete
  // (e.g. emptying response_config of a text rule, or switching trigger_type to one
  // whose required config is now missing) instead of silently persisting it.
  const shape = (r: typeof existing) => ({
    name: r.name,
    channel_id: r.channel_id,
    priority: r.priority,
    trigger_type: r.trigger_type,
    trigger_config: r.trigger_config,
    response_type: r.response_type,
    response_config: r.response_config,
    cooldown_seconds: r.cooldown_seconds,
    max_sends_per_contact: r.max_sends_per_contact,
    requires_approval: r.requires_approval,
  });
  const merged = {
    ...shape(existing),
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
    ...(parsed.data.trigger_type !== undefined ? { trigger_type: parsed.data.trigger_type } : {}),
    ...(parsed.data.trigger_config !== undefined ? { trigger_config: parsed.data.trigger_config } : {}),
    ...(parsed.data.response_type !== undefined ? { response_type: parsed.data.response_type } : {}),
    ...(parsed.data.response_config !== undefined ? { response_config: parsed.data.response_config } : {}),
    ...(parsed.data.cooldown_seconds !== undefined ? { cooldown_seconds: parsed.data.cooldown_seconds } : {}),
    ...(parsed.data.max_sends_per_contact !== undefined ? { max_sends_per_contact: parsed.data.max_sends_per_contact } : {}),
    ...(parsed.data.requires_approval !== undefined ? { requires_approval: parsed.data.requires_approval } : {}),
  };
  const validated = createRuleSchema.safeParse(merged);
  if (!validated.success) {
    // Grandfathering: a rule created under an older, looser schema (e.g. an http:// button
    // before the https-only refine) must stay editable. An issue is grandfathered (ignored) only if
    // it ALREADY existed on the pre-patch rule AND this PATCH leaves the exact offending value
    // untouched — so a toggle/rename goes through, but actively re-setting that value to an invalid
    // one still fails.
    const prior = createRuleSchema.safeParse(shape(existing));
    const issueKey = (iss: { path: PropertyKey[]; message: string }) => `${iss.path.join(".")}|${iss.message}`;
    const priorIssues = new Set(prior.success ? [] : prior.error.issues.map(issueKey));
    // Walk an object along a Zod issue path to the exact value the issue is about.
    const valueAtPath = (root: unknown, path: PropertyKey[]): unknown => {
      let cur: unknown = root;
      for (const key of path) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<PropertyKey, unknown>)[key as keyof typeof cur];
      }
      return cur;
    };
    // Order-insensitive: object-valued issue paths (a whole button / a follow_gate branch)
    // compare a jsonb-canonicalized existing value against client-ordered keys — a stringify compare
    // would falsely differ and re-reject an unchanged legacy object.
    const unchangedAtPath = (path: PropertyKey[]) =>
      deepEqual(valueAtPath(shape(existing), path), valueAtPath(merged, path));
    const introduced = validated.error.issues.filter((iss) => {
      // A violation absent from the pre-patch rule is genuinely new → always report it.
      if (!priorIssues.has(issueKey(iss))) return true;
      // A pre-existing violation is grandfathered ONLY while THIS patch leaves the exact offending
      // value untouched. Keying on the FULL issue path (not just the top-level field) lets a client
      // round-trip an unchanged legacy value inside a wholesale-replaced object — e.g. resend the
      // whole response_config to edit only `text`, carrying an untouched legacy http:// button —
      // while still failing if that button itself is set to a new invalid value.
      return !unchangedAtPath(iss.path);
    });
    if (introduced.length > 0) {
      const fieldErrors: Record<string, string[]> = {};
      for (const iss of introduced) {
        const key = iss.path.length ? String(iss.path[0]) : "_errors";
        (fieldErrors[key] ??= []).push(iss.message);
      }
      return ApiErrors.validationError(fieldErrors);
    }
  }

  const [updated] = await db
    .update(autoReplyRules)
    .set(parsed.data)
    // workspace_id alongside the PK: defense-in-depth so the mutation stays tenant-scoped even
    // if it ever drifts from the ownership precheck above.
    .where(and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)))
    .returning({
      id: autoReplyRules.id,
      name: autoReplyRules.name,
      channel_id: autoReplyRules.channel_id,
      is_active: autoReplyRules.is_active,
      priority: autoReplyRules.priority,
      trigger_type: autoReplyRules.trigger_type,
      trigger_config: autoReplyRules.trigger_config,
      response_type: autoReplyRules.response_type,
      response_config: autoReplyRules.response_config,
      cooldown_seconds: autoReplyRules.cooldown_seconds,
      max_sends_per_contact: autoReplyRules.max_sends_per_contact,
      requires_approval: autoReplyRules.requires_approval,
      created_at: autoReplyRules.created_at,
      updated_at: autoReplyRules.updated_at,
    });

  return ok(updated);
}

// DELETE /api/v1/rules/:ruleId
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  const auth = await authenticateWithScope(request, "rules:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { ruleId } = await params;
  const result = await db
    .delete(autoReplyRules)
    .where(and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, auth.workspaceId)));
  if ((result.rowCount ?? 0) === 0) return ApiErrors.notFound();
  return noContent();
}
