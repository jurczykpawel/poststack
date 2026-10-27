import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

describe("document transition lifecycle", () => {
  it.each(["pageswap", "pagereveal"])("handles a skipped native transition on %s", async (eventName) => {
    const listeners = new Map<string, (event: { viewTransition?: { ready: Promise<void> } }) => void>();
    runInNewContext(readFileSync("src/server/ui/static/view-transitions.js", "utf8"), {
      window: { addEventListener: (name: string, callback: (event: { viewTransition?: { ready: Promise<void> } }) => void) => listeners.set(name, callback) },
    });
    expect([...listeners.keys()].sort()).toEqual(["pagereveal", "pageswap"]);
    const ready = Promise.reject(new DOMException("ViewTransition opt-in disabled", "InvalidStateError"));
    listeners.get(eventName)!({ viewTransition: { ready } });
    // Without a lifecycle handler this rejection surfaces as a browser pageerror.
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get(eventName)!({});
  });
});
