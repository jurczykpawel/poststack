import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderAiGenerationLogs: typeof import("./ai-generation-logs").renderAiGenerationLogs;
type AiGenerationLogRow = import("./ai-generation-logs").AiGenerationLogRow;

const s = (h: unknown) => String(h);

const row = (over: Partial<AiGenerationLogRow>): AiGenerationLogRow =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    kind: "draft",
    model: "gpt-4o-mini",
    systemPrompt: "You draft replies.",
    userMessage: "Congratulations 🎉",
    response: "Thank you!",
    error: null,
    durationMs: 842,
    createdAt: new Date(),
    ...over,
  } as AiGenerationLogRow);

beforeAll(async () => {
  ({ renderAiGenerationLogs } = await import("./ai-generation-logs"));
});

describe("renderAiGenerationLogs — gating", () => {
  it("shows a PRO prompt when the instance is not entitled", () => {
    const out = s(renderAiGenerationLogs([], false, "/pricing"));
    expect(out).toContain("PRO");
    expect(out).toContain("/pricing");
  });

  it("shows an empty state when entitled but no logs exist yet", () => {
    const out = s(renderAiGenerationLogs([], true, "/pricing"));
    expect(out).not.toContain("PRO");
    expect(out).toContain("No AI generations yet");
  });
});

describe("renderAiGenerationLogs — rows", () => {
  it("renders kind, model, duration, and an 'ok' badge for a successful generation", () => {
    const out = s(renderAiGenerationLogs([row({})], true, ""));
    expect(out).toContain("draft");
    expect(out).toContain("gpt-4o-mini");
    expect(out).toContain("842ms");
    expect(out).toContain(">ok<");
  });

  it("renders a 'failed' badge and the error text for a failed generation", () => {
    const out = s(renderAiGenerationLogs([row({ response: null, error: "HTTP 500" })], true, ""));
    expect(out).toContain(">failed<");
    expect(out).toContain("HTTP 500");
  });

  it("includes the full system prompt, user message, and response text", () => {
    const out = s(renderAiGenerationLogs([row({ systemPrompt: "SYS_MARKER", userMessage: "USER_MARKER", response: "RESP_MARKER" })], true, ""));
    expect(out).toContain("SYS_MARKER");
    expect(out).toContain("USER_MARKER");
    expect(out).toContain("RESP_MARKER");
  });

  it("omits the response block when there is no response (failed generation)", () => {
    const out = s(renderAiGenerationLogs([row({ response: null, error: "boom" })], true, ""));
    expect(out).not.toContain("<strong>Response</strong>");
  });

  it("escapes a malicious user message so injected markup is inert", () => {
    const evil = '<script>alert(1)</script>';
    const out = s(renderAiGenerationLogs([row({ userMessage: evil })], true, ""));
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
