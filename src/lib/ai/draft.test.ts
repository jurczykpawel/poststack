import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_DRAFT_PROMPT, resolveDraftPrompt, generateDraft } from "./draft";
import { chatComplete } from "@/lib/ai/client";

// Unit test for the draft-generation layer: it composes prompt + message and delegates to the
// shared chatComplete client. Mock the client so we assert what we pass (system/user) and how we
// propagate its result (string verbatim, or null → caller creates no draft) — no fetch/LLM here.
vi.mock("@/lib/ai/client", () => ({
  chatComplete: vi.fn(),
}));

const chatCompleteMock = vi.mocked(chatComplete);

beforeEach(() => {
  chatCompleteMock.mockReset();
});

describe("resolveDraftPrompt", () => {
  it("uses the channel prompt when present (channel wins)", () => {
    expect(
      resolveDraftPrompt({ channelPrompt: "channel", workspacePrompt: "workspace" }),
    ).toBe("channel");
  });

  it("falls back to the workspace prompt when channel is blank/whitespace", () => {
    expect(resolveDraftPrompt({ channelPrompt: "   ", workspacePrompt: "workspace" })).toBe(
      "workspace",
    );
    expect(resolveDraftPrompt({ channelPrompt: null, workspacePrompt: "workspace" })).toBe(
      "workspace",
    );
    expect(resolveDraftPrompt({ channelPrompt: undefined, workspacePrompt: "workspace" })).toBe(
      "workspace",
    );
  });

  it("falls back to DEFAULT_DRAFT_PROMPT when both are blank/unset", () => {
    expect(resolveDraftPrompt({ channelPrompt: "  ", workspacePrompt: "\n\t " })).toBe(
      DEFAULT_DRAFT_PROMPT,
    );
    expect(resolveDraftPrompt({})).toBe(DEFAULT_DRAFT_PROMPT);
  });

  it("trims the chosen prompt", () => {
    expect(resolveDraftPrompt({ channelPrompt: "  channel  " })).toBe("channel");
  });
});

describe("generateDraft", () => {
  it("labels the message as the customer's new DM and states a private-DM reply target (no context)", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    const result = await generateDraft({
      workspaceId: "WS-1",
      conversationId: "CONV-1",
      incomingText: "Hi there",
      isComment: false,
      target: "dm",
      prompt: "be nice",
    });

    expect(result).toBe("draft reply");
    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.system).toBe("be nice");
    expect(call.user).toBe(
      "Reply target: a private direct message\nCustomer (new direct message — the message to reply to): Hi there",
    );
  });

  it("labels the message as the customer's new public comment and states a public-comment reply target", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    await generateDraft({
      workspaceId: "WS-1",
      conversationId: "CONV-1",
      incomingText: "Nice post!",
      isComment: true,
      target: "public",
      prompt: "be nice",
    });

    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.user).toBe(
      "Reply target: a public comment reply\nCustomer (new public comment — the message to reply to): Nice post!",
    );
  });

  it("states that a 'both' target also sends the same text as a DM", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    await generateDraft({
      workspaceId: "WS-1",
      conversationId: "CONV-1",
      incomingText: "Nice post!",
      isComment: true,
      target: "both",
      prompt: "be nice",
    });

    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.user).toBe(
      "Reply target: a public comment reply (also sent as a DM)\nCustomer (new public comment — the message to reply to): Nice post!",
    );
  });

  it("forwards workspaceId, conversationId, and kind='draft' to chatComplete (ADLOG1/ADLOG2)", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    await generateDraft({ workspaceId: "WS-log", conversationId: "CONV-log", incomingText: "Hi", isComment: false, target: "dm", prompt: "be nice" });
    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.workspaceId).toBe("WS-log");
    expect(call.conversationId).toBe("CONV-log");
    expect(call.kind).toBe("draft");
  });

  it("puts the context first, then a '---' separator, then the reply target + labeled message", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    await generateDraft({
      workspaceId: "WS-1",
      conversationId: "CONV-1",
      incomingText: "Hi there",
      isComment: false,
      target: "dm",
      context: "Customer is asking about refunds.",
      prompt: "be nice",
    });

    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.system).toBe("be nice");
    expect(call.user).toBe(
      "Customer is asking about refunds.\n\n---\nReply target: a private direct message\nCustomer (new direct message — the message to reply to): Hi there",
    );
  });

  it("returns chatComplete's string verbatim", async () => {
    chatCompleteMock.mockResolvedValue("verbatim");
    expect(
      await generateDraft({ workspaceId: "WS-1", conversationId: "CONV-1", incomingText: "x", isComment: false, target: "dm", prompt: "p" }),
    ).toBe("verbatim");
  });

  it("returns null when chatComplete returns null", async () => {
    chatCompleteMock.mockResolvedValue(null);
    expect(
      await generateDraft({ workspaceId: "WS-1", conversationId: "CONV-1", incomingText: "x", isComment: false, target: "dm", prompt: "p" }),
    ).toBeNull();
  });
});
