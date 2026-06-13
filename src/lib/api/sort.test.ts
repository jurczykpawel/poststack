import { describe, it, expect } from "vitest";
import { parseSort } from "./sort";
import { ApiError } from "./response";

describe("parseSort", () => {
  const allowed = ["created_at", "title"] as const;
  it("parses a comma list with - = desc", () => {
    expect(parseSort("-created_at,title", allowed)).toEqual([
      { column: "created_at", dir: "desc" },
      { column: "title", dir: "asc" },
    ]);
  });
  it("returns [] for empty/undefined", () => {
    expect(parseSort(undefined, allowed)).toEqual([]);
    expect(parseSort("", allowed)).toEqual([]);
  });
  it("throws ApiError(422) on a field outside the allow-list", () => {
    expect(() => parseSort("bogus", allowed)).toThrowError(ApiError);
    try {
      parseSort("bogus", allowed);
    } catch (e) {
      expect((e as ApiError).status).toBe(422);
    }
  });
});
