import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { uiBehaviorScript } from "./components/toast";

async function realtimePage() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { body: new EventTarget() });
  const internalData = new Map();
  const liveRegion = { getAttribute: (name: string) => name === "hx-trigger" ? "sse:conversation.updated" : null };
  const shell = {
    querySelectorAll: () => [liveRegion],
    getAttribute: (name: string) => name === "sse-connect" ? "/events/stream" : null,
  };
  Object.assign(document, { querySelector: () => shell });
  const sources: TestSource[] = [];
  class TestSource extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    onerror?: (event: Event) => void;
    close = vi.fn(() => { this.readyState = 2; });
    constructor() { super(); sources.push(this); }
  }
  let extension: { onEvent: (name: string, event: { target: unknown }) => void };
  const errors = vi.fn();
  const api = {
    getInternalData: (elt: unknown) => {
      if (!internalData.has(elt)) internalData.set(elt, {});
      return internalData.get(elt);
    },
    getAttributeValue: (elt: typeof shell, name: string) => elt.getAttribute(name),
    getClosestMatch: () => shell,
    getTriggerSpecs: () => [{ trigger: "sse:conversation.updated" }],
    triggerEvent: vi.fn(),
    triggerErrorEvent: errors,
    bodyContains: () => true,
  };
  const htmx = {
    defineExtension: (_name: string, ext: typeof extension & { init: (api: unknown) => void }) => {
      extension = ext;
      ext.init(api);
    },
    trigger: vi.fn((elt: unknown, name: string) => extension.onEvent(name, { target: elt })),
  };
  const context = { window, document, htmx, EventSource: TestSource };
  // Keep the shipped extension in the test: its error and cleanup paths are the behavior at issue.
  runInNewContext(readFileSync("src/server/ui/static/vendor/htmx-ext-sse-2.2.2.js", "utf8"), context);
  runInNewContext(String(await uiBehaviorScript()).replace(/^<script>\s*|\s*<\/script>$/g, ""), context);
  htmx.trigger(shell, "htmx:afterProcessNode");
  htmx.trigger(liveRegion, "htmx:afterProcessNode");
  return { window, htmx, liveRegion, sources, errors };
}

describe("dashboard realtime lifecycle", () => {
  it.each(["pageswap", "pagehide"])("closes the stream before a navigation disconnect on %s", async (name) => {
    const { window, sources, errors } = await realtimePage();
    window.dispatchEvent(new Event(name));
    // A network disconnect reports an Event only if the source is still open.
    if (sources[0].readyState !== 2) sources[0].onerror?.(new Event("error"));
    expect(sources[0].close).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps the live stream and its error reporting during fragment updates", async () => {
    const { window, sources, errors } = await realtimePage();
    window.dispatchEvent(new Event("htmx:afterSwap"));
    sources[0].onerror?.(new Event("error"));
    expect(sources[0].close).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.anything(), "htmx:sseError", expect.objectContaining({ error: expect.any(Event) }));
  });

  it("closes once across both navigation events and reconnects after a cached page returns", async () => {
    const { window, sources } = await realtimePage();
    window.dispatchEvent(new Event("pageswap"));
    window.dispatchEvent(new Event("pagehide"));
    expect(sources[0].close).toHaveBeenCalledOnce();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(sources).toHaveLength(2);
    expect(sources[1].close).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(sources[1].close).toHaveBeenCalledOnce();
  });

  it("delivers live-region updates through the new stream after returning from cache", async () => {
    const { window, sources, htmx, liveRegion } = await realtimePage();
    sources[0].dispatchEvent(new Event("conversation.updated"));
    expect(htmx.trigger).toHaveBeenCalledWith(liveRegion, "sse:conversation.updated", expect.any(Event));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    htmx.trigger.mockClear();
    sources[1].dispatchEvent(new Event("conversation.updated"));
    expect(htmx.trigger).toHaveBeenCalledWith(liveRegion, "sse:conversation.updated", expect.any(Event));
  });
});
