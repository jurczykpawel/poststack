import { describe, it, expect } from "vitest";
import { parseJsonBody } from "./body-limit";

function jsonReq(body: string) {
  return new Request("http://x", { method: "POST", body });
}

describe("parseJsonBody", () => {
  it("parses a valid small JSON body", async () => {
    const result = await parseJsonBody(jsonReq(JSON.stringify({ hello: "world" })));
    expect(result).toEqual({ hello: "world" });
  });

  it("returns null for a body over the size limit", async () => {
    const big = JSON.stringify({ x: "a".repeat(50_000) });
    expect(await parseJsonBody(jsonReq(big), 1024)).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    expect(await parseJsonBody(jsonReq("{ not valid json"))).toBeNull();
  });

  it("returns null for an empty body", async () => {
    expect(await parseJsonBody(new Request("http://x", { method: "POST" }))).toBeNull();
  });

  it("returns null when Content-Length already exceeds the limit", async () => {
    const req = new Request("http://x", {
      method: "POST",
      headers: { "content-length": "99999" },
      body: JSON.stringify({ ok: true }),
    });
    expect(await parseJsonBody(req, 1024)).toBeNull();
  });
});
