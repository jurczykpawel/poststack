import { describe, it, expect, beforeAll } from "vitest";

let encryptHeaderMap: typeof import("./header-map").encryptHeaderMap;
let decryptHeaderMap: typeof import("./header-map").decryptHeaderMap;
let assertValidHeaderMap: typeof import("./header-map").assertValidHeaderMap;
let parseHeaderLines: typeof import("./header-map").parseHeaderLines;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  ({ encryptHeaderMap, decryptHeaderMap, parseHeaderLines, assertValidHeaderMap } = await import("./header-map"));
});

describe("encryptHeaderMap / decryptHeaderMap", () => {
  it("round-trips a header map", () => {
    const stored = encryptHeaderMap({ Authorization: "Bearer secret123" });
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("secret123");
    expect(decryptHeaderMap(stored)).toEqual({ Authorization: "Bearer secret123" });
  });

  it("an empty or undefined map encrypts to null", () => {
    expect(encryptHeaderMap({})).toBeNull();
    expect(encryptHeaderMap(undefined)).toBeNull();
  });

  it("decrypting null/garbage never throws — returns {}", () => {
    expect(decryptHeaderMap(null)).toEqual({});
    expect(decryptHeaderMap("not-valid-ciphertext")).toEqual({});
  });
});

describe("parseHeaderLines", () => {
  it("parses Key: Value lines, ignoring blanks and malformed lines", () => {
    const out = parseHeaderLines("Authorization: Bearer xxx\n\nX-Api-Key: yyy\nmalformed-line\n:no-key");
    expect(out).toEqual({ Authorization: "Bearer xxx", "X-Api-Key": "yyy" });
  });

  it("trims whitespace around keys and values", () => {
    expect(parseHeaderLines("  X-Foo  :   bar  ")).toEqual({ "X-Foo": "bar" });
  });
});


describe("custom header validation", () => {
  it("accepts HTTP token names and byte values", () => {
    expect(() => assertValidHeaderMap({ "X-Token_1": "Bearer token:with:colons", "X-Empty": "", "X-Label": "café" })).not.toThrow();
    expect(() => assertValidHeaderMap({})).not.toThrow();
    expect(() => assertValidHeaderMap(undefined)).not.toThrow();
  });

  it("rejects control characters before whitespace normalization", () => {
    for (let code = 0; code < 32; code++) {
      const char = String.fromCharCode(code);
      expect(() => assertValidHeaderMap({ "X-Test": `${char}value` })).toThrow(/header/i);
      if (char !== "\n") expect(() => parseHeaderLines(`X-Test: ${char}value`)).toThrow(/header/i);
    }
  });

  it("preserves multiline form headers with either line ending", () => {
    for (const newline of ["\n", "\r\n"]) {
      expect(parseHeaderLines(`X-One: value${newline}X-Two: second`)).toEqual({ "X-One": "value", "X-Two": "second" });
    }
  });
});
