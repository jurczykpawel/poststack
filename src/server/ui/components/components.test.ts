import { describe, it, expect } from "vitest";
import { statusBadge, pill, dot } from "./status";
import { btn } from "./button";
import { icon, iconSprite } from "./icons";
import { platformLabel } from "./platform";

const s = (h: unknown) => String(h);

describe("components", () => {
  it("statusBadge maps channel statuses to tone classes + label text", () => {
    expect(s(statusBadge("active"))).toContain("Healthy");
    expect(s(statusBadge("active"))).toContain("tone-ok");
    expect(s(statusBadge("needs_reauth"))).toContain("tone-warn");
    expect(s(statusBadge("failed"))).toContain("tone-bad");
  });
  it("pill renders text with a tone", () => {
    expect(s(pill("exp 5d", "warn"))).toContain("exp 5d");
    expect(s(pill("exp 5d", "warn"))).toContain("tone-warn");
  });
  it("btn renders variant + label, and href makes it an anchor", () => {
    expect(s(btn({ label: "Reconnect", variant: "primary" }))).toContain("btn-primary");
    expect(s(btn({ label: "Reconnect", variant: "primary" }))).toContain("Reconnect");
    expect(s(btn({ label: "View", href: "/x" }))).toContain('href="/x"');
  });
  it("icon references a sprite symbol; sprite defines it", () => {
    expect(s(icon("reconnect"))).toContain('href="#i-reconnect"');
    expect(s(iconSprite())).toContain('id="i-reconnect"');
  });
  it("platform label still maps meta+instagram subKind", () => {
    expect(platformLabel("meta", { subKind: "instagram" })).toBe("Instagram");
  });
  it("dot emits a tone class", () => {
    expect(s(dot("bad"))).toContain("tone-bad");
  });
  it("btn icon branch includes the sprite use element", () => {
    expect(s(btn({ label: "Go", icon: "plus" }))).toContain('href="#i-plus"');
  });
});
