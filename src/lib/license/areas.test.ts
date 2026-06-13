import { describe, it, expect } from "vitest";
import { slugAreas, allowlistAreas, isArea } from "./areas";

describe("areas", () => {
  it("recognises valid areas", () => {
    expect(isArea("core")).toBe(true);
    expect(isArea("publishing")).toBe(true);
    expect(isArea("replies")).toBe(true);
    expect(isArea("nope")).toBe(false);
  });

  it("maps the all-access poststack slug to every area", () => {
    expect(slugAreas("poststack")).toEqual(new Set(["core", "publishing", "replies"]));
  });

  it("maps per-wing slugs to that wing plus core", () => {
    expect(slugAreas("poststack-publishing")).toEqual(new Set(["core", "publishing"]));
    expect(slugAreas("poststack-replies")).toEqual(new Set(["core", "replies"]));
  });

  it("returns null for an unknown slug (caller decides the default)", () => {
    expect(slugAreas("acme-custom")).toBeNull();
  });

  it("unions areas across a comma-separated allowlist", () => {
    expect(allowlistAreas("poststack-publishing,poststack-replies")).toEqual(
      new Set(["core", "publishing", "replies"]),
    );
    expect(allowlistAreas("poststack-publishing")).toEqual(new Set(["core", "publishing"]));
    expect(allowlistAreas("  poststack-replies , unknown ")).toEqual(new Set(["core", "replies"]));
  });
});
