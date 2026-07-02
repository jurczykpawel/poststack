import { z } from "zod";
import { LIMITS } from "@/lib/api/limits";

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO datetime");
const urls = z.array(z.string().max(LIMITS.url)).max(LIMITS.arrayLen).optional();

// A single-URL field that is nullable so a PATCH can clear it (send null). Empty/whitespace strings
// are normalized to null at the service layer (mapFields) so a URL column is never stored as "",
// which would otherwise poison the publish media resolver.
const optionalUrl = z.string().max(LIMITS.url).nullish();

// Open-set string fields stay free text (doctrine §1) — validated structurally, not as closed enums,
// so values imported from NocoDB are never rejected. Inbound JSON is camelCase.

// PSA8: only client-writable editorial fields are accepted from the public v1 body. System-managed
// lifecycle/provenance — status, approvedAt/approvedBy, lastPublishedAt, published*, postizId,
// assetStatus — is set by the engine/importer (service + direct insert), NOT mass-assignable here,
// so the approval/publish audit trail can't be forged. zod strips any such keys a client sends.
export const contentCreate = z.object({
  title: z.string().min(1).max(LIMITS.name),
  contentType: z.string().max(LIMITS.line).optional(),
  script: z.string().max(LIMITS.text).optional(),
  mediaUrls: urls,
  profile: z.string().max(LIMITS.line).optional(),
  evergreen: z.boolean().optional(),
  republishInterval: z.string().max(LIMITS.line).optional(),
  leadMagnet: z.string().max(LIMITS.line).optional(),
  notes: z.string().max(LIMITS.text).optional(),
  baseDescription: z.string().max(LIMITS.text).optional(),
  baseHashtags: z.string().max(LIMITS.hashtags).optional(),
  ideaSource: z.string().max(LIMITS.line).optional(),
  language: z.string().max(LIMITS.line).optional(),
  sourceRef: z.string().max(LIMITS.ref).optional(),
});
export const contentPatch = contentCreate.partial();

// UNIFY P2.2: the user-writable auto-reply attached to a post (system-managed `ruleId`/`status` are
// stamped by the publish loop-back, never accepted here — PSA8 mass-assignment guard).
// SEQTRIGGER1: the comment trigger can either send a DM (`responseType: "text"`, the default) or
// enroll the commenter into a drip sequence (`responseType: "sequence"` + `sequenceId`).
export const autoReplyInput = z
  .object({
    keywords: z
      .array(z.object({ value: z.string().min(1).max(100), matchType: z.enum(["exact", "contains", "starts_with"]).default("contains") }))
      .min(1)
      .max(100),
    responseType: z.enum(["text", "sequence"]).default("text"),
    dmText: z.string().min(1).max(2000).optional(),
    sequenceId: z.string().uuid().optional(),
    commentReplyText: z.string().min(1).max(2000).optional(),
    replyMode: z.enum(["dm", "comment", "both"]).default("dm"),
    cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.responseType === "text" && !d.dmText) {
      ctx.addIssue({ code: "custom", path: ["dmText"], message: "dmText is required for a text auto-reply" });
    }
    if (d.responseType === "sequence" && !d.sequenceId) {
      ctx.addIssue({ code: "custom", path: ["sequenceId"], message: "sequenceId is required for a sequence auto-reply" });
    }
  });

export const postCreate = z.object({
  contentId: z.string().uuid().optional(),
  platform: z.string().min(1).max(LIMITS.line),
  // Per-post title (required by YouTube / LinkedIn articles at publish; falls back to content.title).
  title: z.string().max(LIMITS.name).nullish(),
  autoReply: autoReplyInput.nullish(),
  // COMPOSE1: per-post automation overrides (null/absent = inherit the channel default).
  firstComment: z.string().max(LIMITS.text).nullish(),
  autoStory: z.boolean().nullish(),
  description: z.string().max(LIMITS.text).optional(),
  hashtags: z.string().max(LIMITS.hashtags).optional(),
  ctaType: z.string().max(LIMITS.line).optional(),
  scheduledDate: iso.optional(),
  notes: z.string().max(LIMITS.text).optional(),
  language: z.string().max(LIMITS.line).optional(),
  mediaUrl: optionalUrl,
  videoUrl: optionalUrl,
  coverUrl: optionalUrl,
  mediaUrls: urls,
  assetNotes: z.string().max(LIMITS.text).optional(),
  sourceRef: z.string().max(LIMITS.ref).optional(),
});
export const postPatch = postCreate.partial();

export type ContentCreate = z.infer<typeof contentCreate>;
export type ContentPatch = z.infer<typeof contentPatch>;
export type AutoReplyInput = z.infer<typeof autoReplyInput>;
export type PostCreate = z.infer<typeof postCreate>;
export type PostPatch = z.infer<typeof postPatch>;

// Service-layer writable shapes: the narrow public fields PLUS the system-managed lifecycle/provenance
// fields that ONLY the engine/importer may set (never the public route, which validates with the
// narrow schemas above). The route's parsed value is assignable to these (the extras are optional).
export type ContentWritable = ContentCreate & {
  status?: string;
  lastPublishedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
};
export type PostWritable = PostCreate & {
  status?: string;
  postizId?: string;
  publishedUrl?: string;
  publishedAt?: string;
  assetStatus?: string;
};
