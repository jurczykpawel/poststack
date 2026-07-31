import type { AiDisclosureLevel } from "@/db/schema";
import { disclosureNote } from "@/lib/ai-disclosure/note";

/**
 * AIDISC2 — where a post's effective AI declaration comes from.
 *
 * One piece of material usually goes out to every channel of a brand, so in practice the brand is the
 * unit that owns the declaration; the channel level exists for the case where one platform's output
 * genuinely differs, and the post always has the last word. Hence a plain most-specific-wins cascade:
 *
 *     post → channel → brand → nothing
 *
 * The level and the note cascade INDEPENDENTLY, which is what makes the common case work: a brand sets
 * its one standard disclosure line, and individual posts only ever say "this one is AI".
 *
 * This is the single place that decides any of it. `disclosureForPlatform` (mapping.ts) then decides
 * what the resolved level means per platform; these two concerns stay apart on purpose.
 */
export type DisclosureSource = "post" | "channel" | "brand" | "default";

export interface ResolvedDisclosure {
  level: AiDisclosureLevel;
  /** Which layer supplied the level — recorded in the audit trail so "why did this disclose?" is answerable. */
  levelSource: DisclosureSource;
  /** The in-content line to publish, already trimmed. `null` = no line (suppressed, or level `none`). */
  note: string | null;
  noteSource: DisclosureSource;
}

/** The shape every default-bearing layer (channel, brand) has in common. */
interface DisclosureDefaults {
  default_ai_disclosure: AiDisclosureLevel | null;
  default_ai_disclosure_note: string | null;
}

export interface ResolveDisclosureInput {
  post: { ai_disclosure: AiDisclosureLevel | null; ai_disclosure_note: string | null };
  channel?: DisclosureDefaults | null;
  brand?: DisclosureDefaults | null;
}

export function resolveDisclosure(input: ResolveDisclosureInput): ResolvedDisclosure {
  const { post, channel, brand } = input;

  // Level: the first layer that set one at all. An explicit `none` on the post counts and wins — that is
  // the only way to turn a brand-wide declaration off for a single post, and the reason the post column
  // is nullable rather than defaulting.
  const levelLayers: Array<[DisclosureSource, AiDisclosureLevel | null | undefined]> = [
    ["post", post.ai_disclosure],
    ["channel", channel?.default_ai_disclosure],
    ["brand", brand?.default_ai_disclosure],
  ];
  const foundLevel = levelLayers.find(([, v]) => v != null);
  const level: AiDisclosureLevel = foundLevel ? foundLevel[1]! : "none";
  const levelSource: DisclosureSource = foundLevel ? foundLevel[0] : "default";

  // A level of `none` discloses nothing, so no line is emitted no matter how many are configured.
  if (level === "none") return { level, levelSource, note: null, noteSource: "default" };

  // Note: the first layer that set one at all — including an EMPTY one, which is a deliberate "no line
  // on this one" and must stop the cascade rather than fall through to a broader layer's wording.
  const noteLayers: Array<[DisclosureSource, string | null | undefined]> = [
    ["post", post.ai_disclosure_note],
    ["channel", channel?.default_ai_disclosure_note],
    ["brand", brand?.default_ai_disclosure_note],
  ];
  const foundNote = noteLayers.find(([, v]) => v != null);
  if (foundNote) {
    // disclosureNote applies the shared trim/suppress rules, so "" and "   " behave identically here and
    // at every other call site.
    return { level, levelSource, note: disclosureNote(level, foundNote[1]), noteSource: foundNote[0] };
  }

  // Nobody wrote one: fall back to the built-in copy for the level ACTUALLY in force, so the line always
  // describes what is being disclosed even when a broader layer was written under a different level.
  return { level, levelSource, note: disclosureNote(level, null), noteSource: "default" };
}
