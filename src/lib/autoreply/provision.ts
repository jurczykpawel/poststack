import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, posts, autoReplyRules, sequences } from "@/db/schema";
import { firstUnlicensedRuleFeature } from "@/lib/rules/feature-gate";

/**
 * REPLYSTACK1, native (UNIFY P2.2): the comment→DM auto-reply attached to an editorial post. Stored
 * on `posts.auto_reply`; on publish the loop-back turns it into a workspace-scoped `auto_reply_rules`
 * row scoped to the resulting media id — entirely in-process (NO HTTP self-call). camelCase on the
 * post; mapped to the rule engine's snake_case trigger/response config here.
 */
export const autoReplySchema = z
  .object({
    version: z.number().int().default(1),
    keywords: z
      .array(z.object({ value: z.string().min(1).max(100), matchType: z.enum(["exact", "contains", "starts_with"]).default("contains") }))
      .max(100)
      .default([]),
    // SEQTRIGGER1: "text" sends `dmText`; "sequence" enrolls the commenter into `sequenceId`.
    responseType: z.enum(["text", "sequence"]).default("text"),
    dmText: z.string().min(1).max(2000).optional(),
    sequenceId: z.string().uuid().optional(),
    commentReplyText: z.string().min(1).max(2000).optional(),
    replyMode: z.enum(["dm", "comment", "both"]).default("dm"),
    cooldownSeconds: z.number().int().min(0).max(86400).optional(),
    // Round-tripped state stamped back on the post after provisioning.
    ruleId: z.string().uuid().optional(),
    status: z.enum(["pending", "active", "skipped_unsupported", "skipped_unlicensed", "error"]).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.responseType === "text" && !d.dmText) {
      ctx.addIssue({ code: "custom", path: ["dmText"], message: "dmText is required for a text auto-reply" });
    }
    if (d.responseType === "sequence" && !d.sequenceId) {
      ctx.addIssue({ code: "custom", path: ["sequenceId"], message: "sequenceId is required for a sequence auto-reply" });
    }
  });

export type AutoReplyConfig = z.infer<typeof autoReplySchema>;

export type ProvisionStatus = "none" | "active" | "skipped_unsupported" | "skipped_unlicensed" | "error";
export interface ProvisionResult {
  status: ProvisionStatus;
  ruleId?: string;
}

const AUTO_REPLY_PLATFORMS = new Set(["facebook", "instagram"]);

/** Stamp `{status, ruleId?}` back onto the post's auto_reply blob (preserving the rest). */
async function stamp(postId: string, base: Record<string, unknown>, patch: { status: ProvisionStatus; ruleId?: string }): Promise<void> {
  await db.update(posts).set({ auto_reply: { ...base, ...patch }, updated_at: new Date() }).where(eq(posts.id, postId));
}

/**
 * Provision (or update) the auto-reply rule for a freshly-published delivery. Idempotent: a stored
 * `ruleId` updates that rule instead of inserting a duplicate (safe under publish retries / re-publish).
 * Meta-only (IG/FB); a richer config that needs a PRO feature the instance lacks is skipped (not 402 —
 * this is a background loop-back), recorded as `skipped_unlicensed` on the post so it's visible.
 */
export async function provisionAutoReply(deliveryId: string, workspaceId: string): Promise<ProvisionResult> {
  const post = await db.query.posts.findFirst({
    where: and(eq(posts.delivery_id, deliveryId), eq(posts.workspace_id, workspaceId)),
  });
  if (!post || post.auto_reply == null) return { status: "none" };

  const parsed = autoReplySchema.safeParse(post.auto_reply);
  const raw = (post.auto_reply ?? {}) as Record<string, unknown>;
  if (!parsed.success) {
    await stamp(post.id, raw, { status: "error" });
    return { status: "error" };
  }
  const cfg = parsed.data;

  if (!AUTO_REPLY_PLATFORMS.has(post.platform)) {
    await stamp(post.id, raw, { status: "skipped_unsupported" });
    return { status: "skipped_unsupported" };
  }

  const delivery = await db.query.deliveries.findFirst({
    where: and(eq(deliveries.id, deliveryId), eq(deliveries.workspace_id, workspaceId)),
    columns: { id: true, channel_id: true, provider_handle: true },
  });
  const mediaId = delivery?.provider_handle;
  if (!delivery || !mediaId) {
    await stamp(post.id, raw, { status: "error" });
    return { status: "error" };
  }

  // Map the camelCase post config to the rule engine's trigger/response config (snake_case).
  const triggerConfig = {
    keywords: cfg.keywords.map((k) => ({ value: k.value, match_type: k.matchType })),
    post_id: mediaId,
  };

  // SEQTRIGGER1: a sequence auto-reply enrolls the commenter into a drip; a text auto-reply DMs them.
  const isSequence = cfg.responseType === "sequence";
  const responseType = isSequence ? ("sequence" as const) : ("text" as const);
  const responseConfig: Record<string, unknown> = isSequence
    ? { sequence_id: cfg.sequenceId }
    : {
        text: cfg.dmText,
        reply_mode: cfg.replyMode,
        ...(cfg.commentReplyText ? { comment_reply_text: cfg.commentReplyText } : {}),
      };

  // A sequence auto-reply must point at an ACTIVE sequence in this workspace (a draft/archived/missing
  // one would never enroll) — validate before provisioning, recording it as an error on the post.
  if (isSequence) {
    const seq = await db.query.sequences.findFirst({
      where: and(eq(sequences.id, cfg.sequenceId!), eq(sequences.workspace_id, workspaceId)),
      columns: { id: true, status: true },
    });
    if (!seq || seq.status !== "active") {
      await stamp(post.id, raw, { status: "error" });
      return { status: "error" };
    }
  }

  // Same authoring gate the HTTP rule-create uses: a PRO feature the instance lacks blocks it (a
  // sequence auto-reply needs the `sequences` feature). As a background loop-back we skip (record it).
  const missing = await firstUnlicensedRuleFeature({ responseType, responseConfig, triggerType: "comment_keyword" });
  if (missing) {
    await stamp(post.id, raw, { status: "skipped_unlicensed" });
    return { status: "skipped_unlicensed" };
  }

  const values = {
    workspace_id: workspaceId,
    channel_id: delivery.channel_id,
    name: `Auto-reply · ${mediaId}`,
    trigger_type: "comment_keyword" as const,
    trigger_config: triggerConfig,
    response_type: responseType,
    response_config: responseConfig,
    cooldown_seconds: cfg.cooldownSeconds ?? 0,
    is_active: true,
  };

  // Idempotent: update the stored rule if it still exists, else insert a fresh one.
  let ruleId = cfg.ruleId;
  const existing = ruleId
    ? await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.id, ruleId), eq(autoReplyRules.workspace_id, workspaceId)), columns: { id: true } })
    : undefined;
  if (existing) {
    await db.update(autoReplyRules).set({ ...values, updated_at: new Date() }).where(eq(autoReplyRules.id, existing.id));
  } else {
    const [row] = await db.insert(autoReplyRules).values(values).returning({ id: autoReplyRules.id });
    ruleId = row!.id;
  }

  await stamp(post.id, raw, { status: "active", ruleId });
  return { status: "active", ruleId };
}
