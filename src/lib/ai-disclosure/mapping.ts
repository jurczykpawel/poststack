import type { AiDisclosureLevel } from "@/db/schema";

/**
 * AIDISC1 — the ONE place that decides what a declared AI level means on each publish target.
 *
 * Context: EU AI Act Art. 50 (Regulation (EU) 2024/1689) applies from 2 August 2026. Art. 50(4) puts a
 * disclosure duty on the DEPLOYER — the person publishing — for content that realistically depicts a
 * person, object, place or event ("deep fake"). The Digital Omnibus (Parliament 2026-06-16, Council
 * 2026-06-29) delayed ONLY Art. 50(2) — the upstream AI-tool vendor's machine-readable marking duty, and
 * only for systems placed on the market before 2 Aug 2026, to 2 Dec 2026. The publisher-side duty this
 * module serves was NOT delayed.
 *
 * Why a three-level enum and not a boolean: the platforms do not mean the same thing by their flags.
 *   - YouTube's `status.containsSyntheticMedia` is scoped to REALISTIC altered/synthetic content —
 *     YouTube states production assistance (scripting, ideas, captions) needs no disclosure, so flagging
 *     an AI-assisted-but-not-synthetic video there would add a label the platform itself says is unneeded.
 *   - Instagram's `is_ai_generated` is documented as a broad "self-disclosure of AI usage in the post".
 *   - TikTok's `is_aigc` and X's `made_with_ai` sit between the two, worded around AI-generated media.
 * So `ai_assisted` discloses everywhere EXCEPT YouTube, and `ai_generated` discloses everywhere.
 * Direction of the tie-break: when a platform's wording is ambiguous we DISCLOSE. Over-disclosure carries
 * no regulatory penalty; under-disclosure is what Art. 99 fines (up to EUR 15M / 3% of worldwide turnover).
 *
 * Field names verified against vendor documentation on 2026-07-31:
 *   youtube   `status.containsSyntheticMedia`  https://developers.google.com/youtube/v3/docs/videos
 *   instagram `is_ai_generated`                https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *   tiktok    `post_info.is_aigc`              https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *   x         `made_with_ai`                   https://docs.x.com/x-api/posts/creation-of-a-post
 *   facebook / threads / linkedin — NO API disclosure field exists (checked the same day against the
 *   Page video publishing guide AND the Page feed doc, the Threads create-posts doc, and the full
 *   LinkedIn Posts API reference — the whole post schema, every content type, zero mention of AI).
 *   This is exactly why `ai_disclosure_note` exists: on those three the visible in-content line is the
 *   ONLY disclosure that reaches the audience.
 */
export interface PlatformDisclosure {
  /** RS platform value this decision is for (`posts.platform`). */
  platform: string;
  /** Whether the platform's publish API exposes a native AI-disclosure field at all. */
  supported: boolean;
  /** The vendor's exact field path, so the stored audit trail is readable without this code. */
  field: string | null;
  /** What we set it to. `null` when the platform has no field to set. */
  value: boolean | null;
  /** Why — recorded verbatim in the audit trail so an auditor never has to re-derive the reasoning. */
  reason: string;
}

/** Platforms whose publish API carries a native AI-disclosure field, and its exact name. */
const NATIVE_FIELD: Readonly<Record<string, string>> = {
  youtube: "status.containsSyntheticMedia",
  instagram: "is_ai_generated",
  tiktok: "post_info.is_aigc",
  x: "made_with_ai",
  twitter: "made_with_ai", // legacy platform value for the same target
};

/** Platforms where the flag is scoped to realistic synthetic depiction, so `ai_assisted` must NOT set it. */
const REALISTIC_ONLY = new Set(["youtube"]);

/**
 * What a declared AI level means for one platform. Pure — no I/O, no clock — so it can be asserted on
 * directly and recomputed identically at publish time and at audit time.
 */
export function disclosureForPlatform(platform: string, level: AiDisclosureLevel): PlatformDisclosure {
  const field = NATIVE_FIELD[platform] ?? null;

  if (level === "none") {
    // Send NOTHING, rather than an explicit `false`. `none` is also what a post with nothing declared
    // resolves to (see resolve.ts), so it means "nobody said" at least as often as "the operator decided
    // there is no AI" — every post that predates this feature arrives here that way. Transmitting `false`
    // would assert a negative on the operator's behalf they may never have made, and on AI content
    // someone simply forgot to mark, it would actively send a false denial. On all four platforms an
    // omitted flag produces the same result as `false` anyway, so the explicit value buys nothing and
    // only adds a claim we cannot stand behind. `supported: true` still records that the platform HAS a
    // field which we deliberately left unset — the audit trail keeps the distinction.
    return {
      platform,
      supported: field !== null,
      field,
      value: null,
      reason: "nothing declared for this post — no disclosure flag sent",
    };
  }

  if (field === null) {
    return {
      platform,
      supported: false,
      field: null,
      value: null,
      reason: `${platform} exposes no AI-disclosure field on its publish API — the in-content note is the only disclosure that reaches the audience`,
    };
  }

  if (level === "ai_assisted" && REALISTIC_ONLY.has(platform)) {
    return {
      platform,
      supported: true,
      field,
      value: false,
      reason: `${platform}'s flag covers realistic altered/synthetic content only; AI production assistance does not require it`,
    };
  }

  return {
    platform,
    supported: true,
    field,
    value: true,
    reason:
      level === "ai_generated"
        ? "declared as realistic AI-generated or AI-altered content"
        : "declared as AI-assisted production",
  };
}

/**
 * The normalized flag handed to a publish provider. Providers stay dumb: they translate one boolean into
 * their own field name and never re-implement the level semantics. `undefined` = set nothing at all,
 * which is what a platform without a field gets.
 */
export function disclosureFlag(platform: string, level: AiDisclosureLevel): boolean | undefined {
  const d = disclosureForPlatform(platform, level);
  return d.value ?? undefined;
}

/** Whether a level requires a visible in-content disclosure line alongside (or instead of) a native flag. */
export function requiresInContentNote(level: AiDisclosureLevel): boolean {
  return level !== "none";
}
