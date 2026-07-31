import type { AiDisclosureLevel } from "@/db/schema";

// AIDISC1: the visible in-content disclosure line. It goes into the caption on EVERY platform, not only
// the ones without a native field — a platform-rendered badge is a platform-controlled artefact that
// does not travel to embeds or reposts, while this line is part of the content itself. It is merely
// load-BEARING on Facebook Pages, Threads and LinkedIn, where nothing else discloses anything at all
// (see mapping.ts header). Exported so callers can show or compare against the default copy without
// hardcoding it twice.
export const AI_GENERATED_DEFAULT_NOTE = "Contains AI-generated content.";
export const AI_ASSISTED_DEFAULT_NOTE = "Created with AI assistance.";

/**
 * What in-content disclosure line (if any) to append to a post's caption for a declared AI level.
 * `custom` is `posts.ai_disclosure_note`: null/undefined falls back to the level's built-in default,
 * while an explicit empty/whitespace string means the operator chose "no note" — distinct from "not set".
 */
export function disclosureNote(level: AiDisclosureLevel, custom: string | null | undefined): string | null {
  if (level === "none") return null;
  if (custom != null) {
    const trimmed = custom.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return level === "ai_generated" ? AI_GENERATED_DEFAULT_NOTE : AI_ASSISTED_DEFAULT_NOTE;
}
