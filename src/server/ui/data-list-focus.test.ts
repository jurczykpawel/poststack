import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it.each([true, false])("returns focus after details close (row clicked: %s)", (clicked) => {
  const listeners = new Map<string, (event: unknown) => void>();
  const focus = vi.fn();
  let detailsOpen = true;
  const list = { id: "data-list" };
  const document = {
    body: { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn) },
    querySelector: () => detailsOpen ? {} : null,
    getElementById: () => list,
    querySelectorAll: () => [{ getAttribute: () => "row-1", matches: () => false, querySelector: () => ({ focus }) }],
  };
  runInNewContext(readFileSync("src/server/ui/static/data-list.js", "utf8"), { document, window: { URL, location: { href: "http://localhost/inbox?open=row-1" } } });
  if (clicked) listeners.get("click")!({ target: { closest: () => ({ getAttribute: () => "row-1", matches: () => false }) } });
  listeners.get("htmx:afterSettle")!({ target: list });
  expect(focus).not.toHaveBeenCalled();
  detailsOpen = false;
  listeners.get("htmx:afterSettle")!({ target: list });
  expect(focus).toHaveBeenCalledOnce();
});
