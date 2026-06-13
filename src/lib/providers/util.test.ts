import { describe, it, expect } from "vitest";
import { asString } from "./util";

describe("asString [PSA51]", () => {
  it("returns a non-empty string and undefined for anything else", () => {
    expect(asString("abc")).toBe("abc");
    expect(asString("")).toBeUndefined();
    expect(asString({ id: 1 })).toBeUndefined(); // a truthy object would pass a `!field` guard
    expect(asString(123)).toBeUndefined();
    expect(asString(["a"])).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
  });
});
