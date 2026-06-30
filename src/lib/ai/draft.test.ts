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
  it("passes the prompt as system and the message as user (no context)", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    const result = await generateDraft({ incomingText: "Hi there", prompt: "be nice" });

    expect(result).toBe("draft reply");
    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.system).toBe("be nice");
    expect(call.user).toBe("Hi there");
  });

  it("includes the context plus the message in the user content when context is given", async () => {
    chatCompleteMock.mockResolvedValue("draft reply");
    await generateDraft({
      incomingText: "Hi there",
      context: "Customer is asking about refunds.",
      prompt: "be nice",
    });

    const call = chatCompleteMock.mock.calls[0][0];
    expect(call.system).toBe("be nice");
    expect(call.user).toBe("Customer is asking about refunds.\n\n---\nMessage: Hi there");
  });

  it("returns chatComplete's string verbatim", async () => {
    chatCompleteMock.mockResolvedValue("verbatim");
    expect(await generateDraft({ incomingText: "x", prompt: "p" })).toBe("verbatim");
  });

  it("returns null when chatComplete returns null", async () => {
    chatCompleteMock.mockResolvedValue(null);
    expect(await generateDraft({ incomingText: "x", prompt: "p" })).toBeNull();
  });
});
