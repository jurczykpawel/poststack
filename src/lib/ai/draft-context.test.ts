import { describe, it, expect, vi, beforeEach } from "vitest";

const resolvePostContext = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();
vi.mock("./post-context", () => ({ resolvePostContext: (...a: unknown[]) => resolvePostContext(...a) }));
const resolveConversationHistory = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();
vi.mock("./conversation-history", () => ({ resolveConversationHistory: (...a: unknown[]) => resolveConversationHistory(...a) }));

let buildDraftContext: typeof import("./draft-context").buildDraftContext;

beforeEach(async () => {
  vi.resetModules();
  resolvePostContext.mockReset().mockResolvedValue(undefined);
  resolveConversationHistory.mockReset().mockResolvedValue(undefined);
  ({ buildDraftContext } = await import("./draft-context"));
});

describe("buildDraftContext — DRY composer shared by both the on-demand and auto AI-draft paths", () => {
  it("joins post context + history with a blank line, post first", async () => {
    resolvePostContext.mockResolvedValue("Post: we launched a new feature");
    resolveConversationHistory.mockResolvedValue("Recent conversation:\nCustomer: hi\nYou: hello");
    const ctx = await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: true, postId: "P1" });
    expect(ctx).toBe("Post: we launched a new feature\n\nRecent conversation:\nCustomer: hi\nYou: hello");
  });

  it("returns just the post context when there is no history", async () => {
    resolvePostContext.mockResolvedValue("Post: we launched a new feature");
    const ctx = await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: true, postId: "P1" });
    expect(ctx).toBe("Post: we launched a new feature");
  });

  it("returns just the history when there is no post context (e.g. a DM thread)", async () => {
    resolveConversationHistory.mockResolvedValue("Recent conversation:\nCustomer: hi\nYou: hello");
    const ctx = await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: false });
    expect(ctx).toBe("Recent conversation:\nCustomer: hi\nYou: hello");
  });

  it("returns undefined when neither produced anything (fresh comment thread, no local/live post match)", async () => {
    const ctx = await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: true, postId: "P1" });
    expect(ctx).toBeUndefined();
  });

  it("never resolves post context for a DM thread (isComment=false) — post captions only apply to comments", async () => {
    await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: false });
    expect(resolvePostContext).not.toHaveBeenCalled();
  });

  it("always resolves conversation history, for both DM and comment threads", async () => {
    await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: false });
    await buildDraftContext({ workspaceId: "WS", channelId: "CH", conversationId: "CONV", isComment: true, postId: "P1" });
    expect(resolveConversationHistory).toHaveBeenCalledTimes(2);
    expect(resolveConversationHistory).toHaveBeenNthCalledWith(1, "CONV", false);
    expect(resolveConversationHistory).toHaveBeenNthCalledWith(2, "CONV", true);
  });
});
