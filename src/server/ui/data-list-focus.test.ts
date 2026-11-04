import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("returns focus only after the close response settles, preserving it across an older settle", () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const focus = vi.fn();
  let detailsOpen = true;
  const list = { id: "data-list" };
  const document = {
    body: { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn) },
    querySelector: () => detailsOpen ? {} : null,
    getElementById: () => list,
    querySelectorAll: () => [{ getAttribute: () => "row-1", querySelector: () => ({ focus }) }],
  };
  runInNewContext(readFileSync("src/server/ui/static/data-list.js", "utf8"), { document });
  listeners.get("click")!({ target: { closest: () => ({ getAttribute: () => "row-1" }) } });
  listeners.get("htmx:afterSettle")!({ target: list });
  expect(focus).not.toHaveBeenCalled();
  detailsOpen = false;
  listeners.get("htmx:afterSettle")!({ target: list });
  expect(focus).toHaveBeenCalledOnce();
});
