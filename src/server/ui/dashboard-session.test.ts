import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it.each([false, true])("restores document visibility on pageshow (persisted=%s)", persisted => {
  const window = new EventTarget();
  const document = { documentElement: { style: { visibility: "" } } };
  const reload = vi.fn(() => document.documentElement.style.visibility);
  Object.assign(window, { location: { reload }, localStorage: { removeItem: vi.fn() } });
  runInNewContext(readFileSync("src/server/ui/static/dashboard-session.js", "utf8"), { window, document });
  window.dispatchEvent(new Event("pagehide"));
  expect(document.documentElement.style.visibility).toBe("hidden");
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
  expect(document.documentElement.style.visibility).toBe("");
  expect(reload).toHaveBeenCalledTimes(persisted ? 1 : 0);
  if (persisted) expect(reload).toHaveReturnedWith("");
});
