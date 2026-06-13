import { describe, it, expect } from "vitest";
import { selectFields, renderTemplate, buildAlertBody } from "./alert-customization";

describe("selectFields", () => {
  it("keeps only whitelisted keys", () => {
    expect(selectFields({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });
  it("is the identity when selection is null/undefined", () => {
    const body = { a: 1, b: 2 };
    expect(selectFields(body, null)).toEqual(body);
    expect(selectFields(body, undefined)).toEqual(body);
  });
});

describe("renderTemplate", () => {
  it("substitutes {{key}} tokens from the context in string leaves", () => {
    expect(renderTemplate("expires in {{days_left}} days", { days_left: "7" })).toBe("expires in 7 days");
  });
  it("replaces unknown placeholders with empty string", () => {
    expect(renderTemplate("{{nope}}!", {})).toBe("!");
  });
  it("recurses into objects and arrays, leaving non-strings untouched", () => {
    const out = renderTemplate({ subject: "Hi {{name}}", tags: ["{{type}}"], n: 5 }, { name: "Acme", type: "token_expiring" });
    expect(out).toEqual({ subject: "Hi Acme", tags: ["token_expiring"], n: 5 });
  });
  it("does not let a value break out of its JSON position (substitutes only at leaves)", () => {
    const out = renderTemplate({ x: "{{v}}" }, { v: '","injected":"1' });
    // the dangerous chars stay a string VALUE, not new structure
    expect(out).toEqual({ x: '","injected":"1' });
  });
});

describe("buildAlertBody", () => {
  const standard = { type: "token_expiring", days_left: 7, detail: "soon", workspace_id: "ws" };

  it("merges rendered extra fields over the (optionally selected) standard body", () => {
    const out = buildAlertBody(
      standard,
      { field_selection: ["type", "days_left"], extra_payload_fields: { subject: "Expires in {{days_left}} days", to: "ops@x.com" } },
      { type: "token_expiring", days_left: "7", detail: "soon", workspace_id: "ws" },
    );
    expect(out).toEqual({ type: "token_expiring", days_left: 7, subject: "Expires in 7 days", to: "ops@x.com" });
  });

  it("returns the full standard body when nothing is customized", () => {
    expect(buildAlertBody(standard, {}, {})).toEqual(standard);
  });
});
