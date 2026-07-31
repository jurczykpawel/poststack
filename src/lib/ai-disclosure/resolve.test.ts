import { describe, it, expect } from "vitest";
import { resolveDisclosure } from "@/lib/ai-disclosure/resolve";
import { AI_GENERATED_DEFAULT_NOTE, AI_ASSISTED_DEFAULT_NOTE } from "@/lib/ai-disclosure/note";

const post = (level: "none" | "ai_assisted" | "ai_generated" | null, note: string | null = null) => ({
  ai_disclosure: level,
  ai_disclosure_note: note,
});
const defaults = (level: "none" | "ai_assisted" | "ai_generated" | null, note: string | null = null) => ({
  default_ai_disclosure: level,
  default_ai_disclosure_note: note,
});

describe("resolveDisclosure — level cascade (most specific wins)", () => {
  it("takes the post's level over both the channel's and the brand's", () => {
    const r = resolveDisclosure({
      post: post("ai_assisted"),
      channel: defaults("ai_generated"),
      brand: defaults("none"),
    });
    expect(r).toMatchObject({ level: "ai_assisted", levelSource: "post" });
  });

  it("falls to the channel when the post sets nothing", () => {
    const r = resolveDisclosure({ post: post(null), channel: defaults("ai_generated"), brand: defaults("none") });
    expect(r).toMatchObject({ level: "ai_generated", levelSource: "channel" });
  });

  it("falls to the brand when neither the post nor the channel sets anything", () => {
    const r = resolveDisclosure({ post: post(null), channel: defaults(null), brand: defaults("ai_assisted") });
    expect(r).toMatchObject({ level: "ai_assisted", levelSource: "brand" });
  });

  it("is 'none' from nowhere in particular when nothing is set anywhere", () => {
    expect(resolveDisclosure({ post: post(null), channel: defaults(null), brand: defaults(null) })).toMatchObject({
      level: "none",
      levelSource: "default",
    });
  });

  it("lets an explicit 'none' on the post override a brand that declares AI", () => {
    // Deliberate, and the reason the post column is nullable: 'none' on the post is a human decision
    // ("this particular one really isn't AI"), distinct from NULL ("nothing set, inherit"). Without
    // this, a brand-wide default could never be turned off for a single post.
    const r = resolveDisclosure({ post: post("none"), channel: defaults(null), brand: defaults("ai_generated") });
    expect(r).toMatchObject({ level: "none", levelSource: "post" });
  });

  it("works when there is no channel or brand at all", () => {
    expect(resolveDisclosure({ post: post("ai_generated") })).toMatchObject({ level: "ai_generated", levelSource: "post" });
    expect(resolveDisclosure({ post: post(null), channel: null, brand: null })).toMatchObject({ level: "none" });
  });
});

describe("resolveDisclosure — note cascade, independent of the level", () => {
  it("reuses the brand's wording when the post declares a level but no note", () => {
    // The common case: the brand has one standard disclosure line, individual posts just say "this is AI".
    const r = resolveDisclosure({
      post: post("ai_generated"),
      channel: defaults(null),
      brand: defaults(null, "Brand line."),
    });
    expect(r).toMatchObject({ level: "ai_generated", levelSource: "post", note: "Brand line.", noteSource: "brand" });
  });

  it("prefers the post's note over the channel's, and the channel's over the brand's", () => {
    expect(
      resolveDisclosure({ post: post("ai_generated", "Post line."), channel: defaults(null, "Chan."), brand: defaults(null, "Brand.") }),
    ).toMatchObject({ note: "Post line.", noteSource: "post" });
    expect(
      resolveDisclosure({ post: post("ai_generated"), channel: defaults(null, "Chan."), brand: defaults(null, "Brand.") }),
    ).toMatchObject({ note: "Chan.", noteSource: "channel" });
  });

  it("falls back to the built-in wording for the resolved level when nobody set a note", () => {
    expect(resolveDisclosure({ post: post("ai_generated") })).toMatchObject({
      note: AI_GENERATED_DEFAULT_NOTE,
      noteSource: "default",
    });
    expect(resolveDisclosure({ post: post("ai_assisted") })).toMatchObject({
      note: AI_ASSISTED_DEFAULT_NOTE,
      noteSource: "default",
    });
  });

  it("uses the built-in wording for the level in force, NOT the level the note was written under", () => {
    // The brand says ai_assisted, the post escalates to ai_generated but supplies no wording. The line
    // must describe what is actually being disclosed, so the built-in ai_generated copy wins over
    // silently reusing an ai_assisted-era default. (A brand note that IS set is the operator's own
    // words and is reused as-is — that is the case above.)
    const r = resolveDisclosure({ post: post("ai_generated"), brand: defaults("ai_assisted") });
    expect(r).toMatchObject({ level: "ai_generated", note: AI_GENERATED_DEFAULT_NOTE, noteSource: "default" });
  });

  it("treats an empty note as an explicit suppression that STOPS the cascade", () => {
    // "" is a deliberate "no line on this one" — it must not fall through to the brand's wording or to
    // the built-in default, otherwise the operator could never turn the note off for a single post.
    const r = resolveDisclosure({
      post: post("ai_generated", ""),
      channel: defaults(null, "Chan."),
      brand: defaults(null, "Brand."),
    });
    expect(r).toMatchObject({ note: null, noteSource: "post" });
  });

  it("treats a whitespace-only note the same as an empty one", () => {
    expect(resolveDisclosure({ post: post("ai_generated", "   \n ") })).toMatchObject({ note: null, noteSource: "post" });
  });

  it("suppression at the channel level stops the cascade too, without touching the brand", () => {
    const r = resolveDisclosure({ post: post("ai_generated"), channel: defaults(null, ""), brand: defaults(null, "Brand.") });
    expect(r).toMatchObject({ note: null, noteSource: "channel" });
  });

  it("trims surrounding whitespace off a note it does use", () => {
    expect(resolveDisclosure({ post: post("ai_generated", "  Line.  ") })).toMatchObject({ note: "Line." });
  });

  it("never emits a note when the resolved level is 'none', however many notes are set", () => {
    const r = resolveDisclosure({
      post: post("none", "stray"),
      channel: defaults(null, "Chan."),
      brand: defaults("ai_generated", "Brand."),
    });
    expect(r).toMatchObject({ level: "none", note: null, noteSource: "default" });
  });
});

describe("resolveDisclosure — provenance is always reported", () => {
  it("names a source for both the level and the note in every combination", () => {
    const levels = [null, "none", "ai_assisted", "ai_generated"] as const;
    const notes = [null, "", "text"] as const;
    const sources = ["post", "channel", "brand", "default"];
    for (const pl of levels)
      for (const pn of notes)
        for (const cl of levels)
          for (const bl of levels) {
            const r = resolveDisclosure({ post: post(pl, pn), channel: defaults(cl), brand: defaults(bl) });
            expect(sources).toContain(r.levelSource);
            expect(sources).toContain(r.noteSource);
            // A note is either absent or a non-empty trimmed string — never "" or whitespace.
            if (r.note !== null) {
              expect(r.note).toBe(r.note.trim());
              expect(r.note.length).toBeGreaterThan(0);
            }
          }
  });
});
