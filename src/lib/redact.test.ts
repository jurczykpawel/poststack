import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets [PSA13]", () => {
  it("redacts tokens/secrets in query-string, JSON, and Bearer forms", () => {
    const q = redactSecrets("GET https://graph.facebook.com/x?fields=y&access_token=EAABIGSECRET123 -> 400");
    expect(q).toContain("access_token=[REDACTED]");
    expect(q).not.toContain("EAABIGSECRET123");

    const j = redactSecrets('upstream said {"access_token":"SECRETV","ok":false}');
    expect(j).toContain('"access_token":"[REDACTED]"');
    expect(j).not.toContain("SECRETV");

    expect(redactSecrets("client_secret=abc123def&grant_type=x")).toContain("client_secret=[REDACTED]");
    expect(redactSecrets("refresh_token=rt-9988")).toContain("refresh_token=[REDACTED]");
    expect(redactSecrets("Authorization: Bearer abc123.def-456ghi")).toContain("Bearer [REDACTED]");
  });

  it("leaves benign error strings untouched", () => {
    expect(redactSecrets("rate limited by provider (429)")).toBe("rate limited by provider (429)");
    expect(redactSecrets("Meta token invalid: error code 190")).toBe("Meta token invalid: error code 190");
  });
});
