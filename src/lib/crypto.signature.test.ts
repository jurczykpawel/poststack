import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyMetaSignatureAny } from "./crypto";

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

describe("verifyMetaSignatureAny", () => {
  const body = '{"object":"instagram"}';
  it("accepts a body signed with the FB secret", () => {
    expect(verifyMetaSignatureAny(body, sign(body, "FB"), ["FB", "IG"])).toBe(true);
  });
  it("accepts a body signed with the IG secret", () => {
    expect(verifyMetaSignatureAny(body, sign(body, "IG"), ["FB", "IG"])).toBe(true);
  });
  it("rejects a body signed with an unknown secret", () => {
    expect(verifyMetaSignatureAny(body, sign(body, "NOPE"), ["FB", "IG"])).toBe(false);
  });
  it("rejects when signature header is missing", () => {
    expect(verifyMetaSignatureAny(body, null, ["FB", "IG"])).toBe(false);
  });
  it("ignores empty secrets in the list", () => {
    expect(verifyMetaSignatureAny(body, sign(body, "IG"), ["", "IG"])).toBe(true);
  });
});
