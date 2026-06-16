import { describe, it, expect } from "vitest";
import {
  messagingWindowState,
  STANDARD_WINDOW_MS,
  HUMAN_AGENT_WINDOW_MS,
} from "./messaging-window";

const now = new Date("2026-06-16T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 60 * 60 * 1000;

describe("messagingWindowState", () => {
  it("does not apply to non-Meta platforms", () => {
    const s = messagingWindowState({ platform: "telegram", threadType: "dm", lastInboundAt: ago(48 * HOUR), now });
    expect(s.kind).toBe("na");
    expect(s.useHumanAgentTag).toBe(false);
    expect(s.label).toBeNull();
  });

  it("does not apply to comment threads (only DMs have the 24h window)", () => {
    const s = messagingWindowState({ platform: "facebook", threadType: "comment", lastInboundAt: ago(48 * HOUR), now });
    expect(s.kind).toBe("na");
    expect(s.useHumanAgentTag).toBe(false);
  });

  it("is open well within 24h — no tag, no warning", () => {
    const s = messagingWindowState({ platform: "instagram", threadType: "dm", lastInboundAt: ago(2 * HOUR), now });
    expect(s.kind).toBe("open");
    expect(s.useHumanAgentTag).toBe(false);
    expect(s.label).toBeNull();
    expect(s.closesInMs).toBe(STANDARD_WINDOW_MS - 2 * HOUR);
  });

  it("flags closing_soon in the last 6h of the window (still RESPONSE, just a heads-up)", () => {
    const s = messagingWindowState({ platform: "facebook", threadType: "dm", lastInboundAt: ago(20 * HOUR), now });
    expect(s.kind).toBe("closing_soon");
    expect(s.useHumanAgentTag).toBe(false);
    expect(s.label).toMatch(/closes in/i);
  });

  it("past 24h but within 7 days → human_agent (tag) with an informative label", () => {
    const s = messagingWindowState({ platform: "facebook", threadType: "dm", lastInboundAt: ago(48 * HOUR), now });
    expect(s.kind).toBe("human_agent");
    expect(s.useHumanAgentTag).toBe(true);
    expect(s.label).toMatch(/human-agent/i);
  });

  it("past 7 days → expired (tag won't save it; warn the operator)", () => {
    const s = messagingWindowState({ platform: "instagram", threadType: "dm", lastInboundAt: ago(HUMAN_AGENT_WINDOW_MS + HOUR), now });
    expect(s.kind).toBe("expired");
    expect(s.useHumanAgentTag).toBe(true);
    expect(s.label).toMatch(/7-day|reject/i);
  });

  it("no inbound on record → treated as outside the window (tag) for a Meta DM", () => {
    const s = messagingWindowState({ platform: "facebook", threadType: "dm", lastInboundAt: null, now });
    expect(s.useHumanAgentTag).toBe(true);
    expect(s.kind).toBe("expired");
  });

  it("defaults threadType to DM when omitted (Meta conversations are DMs unless told otherwise)", () => {
    const s = messagingWindowState({ platform: "facebook", lastInboundAt: ago(2 * HOUR), now });
    expect(s.kind).toBe("open");
  });
});
