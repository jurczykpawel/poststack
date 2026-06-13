import { z } from "zod";
import { LIMITS } from "@/lib/api/limits";

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO datetime");
const urls = z.array(z.string().max(LIMITS.url)).max(LIMITS.arrayLen).optional();

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

export const postCreate = z.object({
  contentId: z.string().uuid().optional(),
  platform: z.string().min(1).max(LIMITS.line),
  description: z.string().max(LIMITS.text).optional(),
  hashtags: z.string().max(LIMITS.hashtags).optional(),
  ctaType: z.string().max(LIMITS.line).optional(),
  scheduledDate: iso.optional(),
  notes: z.string().max(LIMITS.text).optional(),
  language: z.string().max(LIMITS.line).optional(),
  mediaUrl: z.string().max(LIMITS.url).optional(),
  videoUrl: z.string().max(LIMITS.url).optional(),
  coverUrl: z.string().max(LIMITS.url).optional(),
  mediaUrls: urls,
  assetNotes: z.string().max(LIMITS.text).optional(),
  sourceRef: z.string().max(LIMITS.ref).optional(),
});
export const postPatch = postCreate.partial();

export type ContentCreate = z.infer<typeof contentCreate>;
export type ContentPatch = z.infer<typeof contentPatch>;
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
