import { z } from "zod";
import { LIMITS } from "@/lib/api/limits";

/** MQA13-B01: a brand key appears in URLs and markup, so it is a slug (letters, digits, `.`, `_`, `-`;
 *  no leading dot). MQA13-B05: the accent is written into a style attribute, so it is a hex colour. */
export const BRAND_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The same rule as BRAND_KEY_RE for the `pattern` attribute (implicitly anchored; `-` escaped so it also compiles under the `v` flag). */
export const BRAND_KEY_HTML_PATTERN = "[A-Za-z0-9][A-Za-z0-9._\\-]*";
export const BRAND_ACCENT_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const BRAND_NAME_MAX = 100;
export const brandName = z.string().trim().min(1, "Brand name is required").max(BRAND_NAME_MAX, `Brand name must be at most ${BRAND_NAME_MAX} characters`);

const aiDisclosure = {
  // AIDISC2: brand-wide default AI declaration. Explicit null clears it.
  default_ai_disclosure: z.enum(["none", "ai_assisted", "ai_generated"], "Choose a valid AI disclosure option").nullish(),
  default_ai_disclosure_note: z.string().max(LIMITS.line).nullish(),
};

/** POST /brands body — also the OpenAPI request schema. */
export const brandCreate = z.object({
  key: z.string().min(1).max(LIMITS.ref).regex(BRAND_KEY_RE, "letters, digits, dots, dashes and underscores only"),
  name: brandName,
  accent: z.string().regex(BRAND_ACCENT_RE, "hex colour like #7aa2f7").optional(),
  icon: z.string().max(LIMITS.line).optional(),
  story_template: z.string().max(LIMITS.ref).nullable().optional(),
  ...aiDisclosure,
});

/** PATCH /brands/{brandKey} body — also the OpenAPI request schema. */
export const brandPatch = z.object({
  name: brandName.optional(),
  accent: z.string().regex(BRAND_ACCENT_RE, "hex colour like #7aa2f7").nullable().optional(),
  icon: z.string().max(LIMITS.line).nullable().optional(),
  story_template: z.string().max(LIMITS.ref).nullable().optional(),
  ...aiDisclosure,
});
