import { describe, it, expect } from "vitest";
import { classifyChangeEvent } from "@/lib/webhook-events/log";

const feed = (value: Record<string, unknown>) => ({ field: "feed", value });

describe("classifyChangeEvent — post reactions/likes", () => {
  it("classifies a Facebook post reaction (add) as an incoming-post-reaction job", () => {
    const c = classifyChangeEvent(
      feed({ item: "reaction", verb: "add", reaction_type: "love", post_id: "P1", from: { id: "U1", name: "Ann" }, created_time: 1_700_000_000 }),
      "facebook",
      "page",
    );
    expect(c?.job?.task).toBe("incoming-post-reaction");
    expect(c?.log.event_type).toBe("post_reaction");
  });

  it("classifies a plain post like (add) as an incoming-post-reaction job", () => {
    const c = classifyChangeEvent(feed({ item: "like", verb: "add", post_id: "P1", from: { id: "U2", name: "Bo" } }), "facebook", "page");
    expect(c?.job?.task).toBe("incoming-post-reaction");
  });

  it("classifies an unreact (remove) as a job so the worker can delete it", () => {
    const c = classifyChangeEvent(feed({ item: "reaction", verb: "remove", reaction_type: "love", post_id: "P1", from: { id: "U1" } }), "facebook", "page");
    expect(c?.job?.task).toBe("incoming-post-reaction");
  });

  it("classifies a reaction EDIT (reactor swapped their reaction) as a job so the worker can update it", () => {
    const c = classifyChangeEvent(
      feed({ item: "reaction", verb: "edit", reaction_type: "haha", post_id: "P1", from: { id: "U1", name: "Ann" }, created_time: 1_700_000_000 }),
      "facebook",
      "page",
    );
    expect(c?.job?.task).toBe("incoming-post-reaction");
    expect(c?.log.event_type).toBe("post_reaction");
    expect(c?.log.event_key).toContain("edit"); // distinct log row from the original add
  });

  it("does not classify a reaction missing the reactor id or post id as a job", () => {
    const noReactor = classifyChangeEvent(feed({ item: "reaction", verb: "add", reaction_type: "love", post_id: "P1" }), "facebook", "page");
    expect(noReactor?.job).toBeNull();
    const noPost = classifyChangeEvent(feed({ item: "reaction", verb: "add", reaction_type: "love", from: { id: "U1" } }), "facebook", "page");
    expect(noPost?.job).toBeNull();
  });

  it("still classifies a comment add as an incoming-comment job", () => {
    const c = classifyChangeEvent(feed({ item: "comment", verb: "add", comment_id: "C1", from: { id: "U1", name: "Ann" }, message: "hi" }), "facebook", "page");
    expect(c?.job?.task).toBe("incoming-comment");
  });

  it("classifies an Instagram live_comments add as an incoming-comment job (same flat shape as comments)", () => {
    const c = classifyChangeEvent(
      { field: "live_comments", value: { id: "LC1", text: "hi from the live", from: { id: "IGSID9", username: "joe" }, media: { id: "M1" } } },
      "instagram",
      "instagram",
    );
    expect(c?.job?.task).toBe("incoming-comment");
    expect(c?.log.event_type).toBe("comment");
    expect(c?.log.platform_message_id).toBe("LC1");
  });

  // WHOBS1 signal-vs-noise: recognized FB feed activity we deliberately don't act on is logged as
  // `ignored` (durable, inspectable) rather than `unknown`/`unhandled`, so the panel's "unhandled
  // types" stays focused on genuinely-unrouted shapes.
  it("classifies Page content lifecycle (video edited) as ignored, not unknown", () => {
    const c = classifyChangeEvent(feed({ item: "video", verb: "edited", post_id: "P1", from: { id: "U1", name: "Bo" } }), "facebook", "page");
    expect(c?.log.event_type).toBe("ignored");
    expect(c?.terminalStatus).toBe("ignored");
    expect(c?.job).toBeNull();
  });

  it("classifies a reaction on a COMMENT as ignored (not a post reaction, not unknown)", () => {
    const c = classifyChangeEvent(feed({ item: "reaction", verb: "add", reaction_type: "love", comment_id: "C1", post_id: "P1", from: { id: "U1" } }), "facebook", "page");
    expect(c?.log.event_type).toBe("ignored");
    expect(c?.terminalStatus).toBe("ignored");
  });

  it("classifies a comment edit/remove as ignored", () => {
    const c = classifyChangeEvent(feed({ item: "comment", verb: "remove", comment_id: "C1", from: { id: "U1" } }), "facebook", "page");
    expect(c?.log.event_type).toBe("ignored");
  });

  it("keeps a genuinely-unrecognized change (an IG field we don't handle) as unknown/unhandled — still surfaced", () => {
    const c = classifyChangeEvent({ field: "messaging_referral", value: { ref: "x" } }, "instagram", "instagram");
    expect(c?.log.event_type).toBe("unknown");
    expect(c?.terminalStatus).toBe("unhandled");
  });
});
