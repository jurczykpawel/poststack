import { describe, it, expect } from "vitest";
import { classifyMessagingEvent, type MetaMessagingEvent } from "@/lib/webhook-events/log";

const ev = (e: Partial<MetaMessagingEvent>): MetaMessagingEvent => ({ timestamp: 1_700_000_000_000, ...e });

describe("classifyMessagingEvent — echo / receipts (THREADSYNC1)", () => {
  it("classifies a page-sent echo as an incoming-echo job", () => {
    const c = classifyMessagingEvent(
      ev({ sender: { id: "PAGE" }, recipient: { id: "USER" }, message: { mid: "m_echo", text: "hi", is_echo: true } }),
      "facebook",
      "PAGE",
      "page",
    );
    expect(c?.log.event_type).toBe("echo");
    expect(c?.job?.task).toBe("incoming-echo");
    expect(c?.job?.jobKey).toBe("echo-m_echo");
  });

  it("classifies a read receipt as an incoming-receipt job", () => {
    const c = classifyMessagingEvent(
      ev({ sender: { id: "USER" }, recipient: { id: "PAGE" }, read: { watermark: 1_700_000_000_000 } }),
      "facebook",
      "PAGE",
      "page",
    );
    expect(c?.log.event_type).toBe("seen");
    expect(c?.job?.task).toBe("incoming-receipt");
  });

  it("classifies a delivery receipt as an incoming-receipt job", () => {
    const c = classifyMessagingEvent(
      ev({ sender: { id: "USER" }, recipient: { id: "PAGE" }, delivery: { mids: ["m1"], watermark: 1_700_000_000_000 } }),
      "facebook",
      "PAGE",
      "page",
    );
    expect(c?.log.event_type).toBe("delivery");
    expect(c?.job?.task).toBe("incoming-receipt");
  });

  it("logs but does not enqueue a receipt with no sender or watermark", () => {
    const noSender = classifyMessagingEvent(ev({ recipient: { id: "PAGE" }, read: { watermark: 1 } }), "facebook", "PAGE", "page");
    expect(noSender?.job).toBeNull();
    const noWatermark = classifyMessagingEvent(ev({ sender: { id: "USER" }, read: {} }), "facebook", "PAGE", "page");
    expect(noWatermark?.job).toBeNull();
  });
});
