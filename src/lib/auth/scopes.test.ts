import { describe, expect, it } from "vitest";
import {
  API_SCOPE_DEFINITIONS,
  API_SCOPE_GROUPS,
  API_SCOPE_PRESETS,
  API_SCOPES,
} from "./scopes";

describe("API scope catalog", () => {
  it("derives the public scope list from one unique, grouped catalog", () => {
    expect(API_SCOPES).toEqual(API_SCOPE_DEFINITIONS.map(({ scope }) => scope));
    expect(new Set(API_SCOPES).size).toBe(API_SCOPES.length);

    const groupIds = new Set(API_SCOPE_GROUPS.map(({ id }) => id));
    expect(groupIds.size).toBe(API_SCOPE_GROUPS.length);
    expect(new Set(API_SCOPE_DEFINITIONS.map(({ group }) => group))).toEqual(groupIds);
    expect(API_SCOPE_GROUPS.every(({ label, description }) => label.length > 0 && description.length > 0)).toBe(true);
    expect(API_SCOPE_DEFINITIONS.every(({ scope, access, label }) =>
      label.length > 0 && scope.endsWith(`:${access}`),
    )).toBe(true);
  });

  it("keeps every preset non-empty, unique and inside the public catalog", () => {
    for (const preset of API_SCOPE_PRESETS) {
      expect(preset.scopes.length, preset.id).toBeGreaterThan(0);
      expect(new Set(preset.scopes).size, preset.id).toBe(preset.scopes.length);
      expect(preset.scopes.every((scope) => API_SCOPES.includes(scope)), preset.id).toBe(true);
      expect(preset.scopes.map((scope) => API_SCOPES.indexOf(scope)), preset.id).toEqual(
        [...preset.scopes].map((scope) => API_SCOPES.indexOf(scope)).sort((a, b) => a - b),
      );
    }
  });

  it("derives read-only from access metadata and keeps publishing least-purposeful", () => {
    const readOnly = API_SCOPE_PRESETS.find(({ id }) => id === "read_only");
    expect(readOnly?.scopes).toEqual(
      API_SCOPE_DEFINITIONS.filter(({ access }) => access === "read").map(({ scope }) => scope),
    );

    const publishing = API_SCOPE_PRESETS.find(({ id }) => id === "publishing");
    expect(publishing?.scopes).toEqual([
      "channels:read",
      "content:read",
      "content:write",
      "posts:read",
      "posts:write",
      "brands:read",
      "media:write",
    ]);
  });
});
