import { describe, it, expect } from "vitest";
import { copyBtn } from "./copy";

describe("copyBtn", () => {
  it("renders a clipboard button carrying the text + label", () => {
    const out = String(copyBtn("hello world", "Copy caption"));
    expect(out).toContain('data-copy="hello world"');
    expect(out).toContain("clipboard.writeText");
    expect(out).toContain("Copy caption");
    expect(out).toContain("copy-btn");
  });

  it("escapes quotes/markup in the copied text (no XSS via data-copy)", () => {
    const out = String(copyBtn('a"b<c'));
    expect(out).not.toContain('a"b<c');
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;");
  });

  it("defaults the label to Copy", () => {
    expect(String(copyBtn("x"))).toContain("Copy");
  });
});
