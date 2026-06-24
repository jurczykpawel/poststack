import { describe, it, expect } from "vitest";
import { conversations, channels, conversationThreadType } from "@/db/schema";

describe("CH-GM1 schema", () => {
  it("conversations has a subject column", () => {
    expect(conversations.subject).toBeDefined();
  });
  it("thread_type enum includes 'email'", () => {
    expect(conversationThreadType.enumValues).toContain("email");
  });
  it("channels has gmail_query + gmail_sync_cursor", () => {
    expect(channels.gmail_query).toBeDefined();
    expect(channels.gmail_sync_cursor).toBeDefined();
  });
});
