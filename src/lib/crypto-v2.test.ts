import { reference as referenceValue } from "../../tests/helpers/versioned-values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptString, decryptTokens, encryptString } from "./crypto";
import { decryptHeaderMap } from "./webhooks/header-map";

const passphrase = "reference-current-passphrase-00000000";
const previous = "reference-previous-passphrase-0000000";
const context: [string, string, ...string[]] = ["ws:workspace-a", "channels.token_encrypted", "facebook", "page-a"];
const reference = (text: string, secret = passphrase, ctx = context) => referenceValue(text, secret, ctx);
afterEach(() => vi.unstubAllEnvs());
function configure() { vi.stubEnv("ENCRYPTION_KEY", passphrase); vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", ""); vi.stubEnv("ENCRYPTION_READ_MODE", ""); }

describe("versioned string reader", () => {
  it("reads reference text and token values", () => {
    configure();
    expect(reference("Zażółć 🐈")).toBe("ps2.Kiw-qJ3c.AAECAwQFBgcICQoL.KdJJ_b1sjYn33tWZYvth-Z_Rk2MAvaIXq25U-0W16A");
    expect(decryptString(reference("Zażółć 🐈"), context)).toBe("Zażółć 🐈");
    expect(decryptString(reference(""), context)).toBe("");
    expect(decryptTokens(reference('{"access_token":"example"}'), context)).toEqual({ access_token: "example" });
  });
  it("selects a previous key by its identifier", () => {
    configure(); vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", JSON.stringify([previous]));
    expect(decryptString(reference("old", previous), context)).toBe("old");
  });
  it.each([undefined, ["ws:workspace-b", ...context.slice(1)], [context[0], "channels.other", ...context.slice(2)], [...context.slice(0, 3), "page-b"]])("requires the matching context %j", (ctx) => {
    configure();
    expect(() => decryptString(reference("example"), ctx as typeof context)).toThrow();
  });
  it("uses the expected row when reading two stored values", () => {
    configure(); const second: typeof context = [...context]; second[3] = "page-b";
    const rows = [reference("first"), reference("second", passphrase, second)];
    expect(decryptString(rows[1], second)).toBe("second");
    expect(() => decryptString(rows[0], second)).toThrow();
  });
  it("reports an unavailable identifier without another format attempt", () => {
    configure(); expect(() => decryptString(reference("example", previous), context)).toThrow("Encryption key unavailable");
  });
  it.each(["ps3.a.b.c", "ps2.a.b.c", "ps2.abcdefgh.AA.AA", "ps2.abcdefgh.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA=", "ps2.abcdefgh.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.extra"]) ("rejects unsupported input %s", (stored) => {
    configure(); expect(() => decryptString(stored, context)).toThrow();
  });
  it("checks every encoded component and the final result", () => {
    configure(); const stored = reference("example");
    expect(() => decryptString(stored + "=", context)).toThrow();
    expect(() => decryptString(stored.slice(0, -2) + "AA", context)).toThrow();
    expect(() => decryptString(stored.replace("AAECAwQFBgcICQoL", "AAECAwQFBgcICQoL="), context)).toThrow();
    expect(() => decryptString(reference("x".repeat(1048577)), context)).toThrow();
  });
  it.each(["not-json", "{}", '["short"]', '[42]']) ("rejects invalid previous configuration %s", (value) => {
    configure(); vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", value);
    expect(() => decryptString(reference("example"), context)).toThrow();
  });
  it("reads the maximum supported text length", () => {
    configure(); const text = "x".repeat(1048576);
    expect(decryptString(reference(text), context)).toBe(text);
  });
  it("keeps passphrase bytes and duplicate keys unchanged", () => {
    configure(); const spaced = "  " + passphrase + "  ";
    vi.stubEnv("ENCRYPTION_KEY", spaced); vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", JSON.stringify([spaced]));
    expect(decryptString(reference("value", spaced), context)).toBe("value");
    expect(() => decryptString(reference("value"), context)).toThrow();
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", JSON.stringify(Array(17).fill(passphrase)));
    expect(() => decryptString(reference("value", spaced), context)).toThrow();
  });
  it("reads configured headers or reports their read failure", () => {
    configure(); const stored = reference('{"X-Example":"value"}');
    expect(decryptHeaderMap(stored, context)).toEqual({ "X-Example": "value" });
    expect(() => decryptHeaderMap(stored)).toThrow();
    vi.stubEnv("ENCRYPTION_KEY", previous);
    expect(() => decryptHeaderMap(stored, context)).toThrow("Encryption key unavailable");
  });
  it("requires the primary key even when a previous key is provided", () => {
    configure(); vi.stubEnv("ENCRYPTION_KEY", ""); vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", JSON.stringify([passphrase]));
    expect(() => decryptString(reference("example"), context)).toThrow("ENCRYPTION_KEY must be set");
  });
  it("keeps the existing writer and default reader", () => {
    configure(); const stored = encryptString("existing");
    expect(stored.split(":")).toHaveLength(3);
    expect(decryptString(stored)).toBe("existing");
    expect(decryptString(stored, context)).toBe("existing");
    vi.stubEnv("ENCRYPTION_READ_MODE", "v2-only");
    expect(() => decryptString(stored, context)).toThrow();
    expect(decryptString(reference("current"), context)).toBe("current");
  });
  it("requires an explicit supported read mode", () => {
    configure(); vi.stubEnv("ENCRYPTION_READ_MODE", "other");
    expect(() => decryptString(encryptString("existing"))).toThrow();
  });
});
