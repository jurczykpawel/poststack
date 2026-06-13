import { describe, it, expect } from "vitest";
import {
  ProviderError,
  TokenInvalidError,
  TransientError,
  PermanentError,
  RateLimitedError,
} from "./errors";

describe("provider errors", () => {
  it("all extend ProviderError and carry a kind", () => {
    expect(new TokenInvalidError("x").kind).toBe("token_invalid");
    expect(new TransientError("x").kind).toBe("transient");
    expect(new PermanentError("x").kind).toBe("permanent");
    expect(new RateLimitedError("x", 30).kind).toBe("rate_limited");
    expect(new TokenInvalidError("x")).toBeInstanceOf(ProviderError);
  });

  it("RateLimitedError carries retryAfterSeconds", () => {
    expect(new RateLimitedError("slow down", 42).retryAfterSeconds).toBe(42);
  });
});
