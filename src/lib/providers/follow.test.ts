import { describe, it, expect } from "vitest";
import { assertAllowedHost } from "./follow";
import { PermanentError } from "./errors";

describe("assertAllowedHost [PSA50]", () => {
  it("allows a known host or its subdomains over https", () => {
    expect(() => assertAllowedHost("https://graph.facebook.com/x?access_token=T", ["facebook.com"])).not.toThrow();
    expect(() => assertAllowedHost("https://rupload.facebook.com/r1", ["facebook.com", "fbcdn.net"])).not.toThrow();
    expect(() => assertAllowedHost("https://upload.googleapis.com/s", ["googleapis.com"])).not.toThrow();
  });

  it("refuses an internal/attacker host, a suffix-trick, or non-https", () => {
    expect(() => assertAllowedHost("http://169.254.169.254/latest/meta-data", ["facebook.com"])).toThrow(PermanentError);
    expect(() => assertAllowedHost("https://evil.example/u", ["facebook.com"])).toThrow(PermanentError);
    expect(() => assertAllowedHost("https://notfacebook.com/u", ["facebook.com"])).toThrow(PermanentError); // not a real subdomain
    expect(() => assertAllowedHost("http://graph.facebook.com/x", ["facebook.com"])).toThrow(PermanentError); // non-https
    expect(() => assertAllowedHost("not a url", ["facebook.com"])).toThrow(PermanentError);
  });
});
