import { describe, it, expect } from "vitest";
import type { TokenData } from "@/lib/platforms/base";
import type { NormalizedEmail } from "./email";
import { EmailProvider } from "./email";

class FakeEmail extends EmailProvider {
  readonly platform = "gmail" as const;
  readonly displayName = "Fake";
  generateAuthUrl() { return ""; }
  async authenticate() { return []; }
  async refreshToken(t: TokenData) { return t; }
  async sendMessage() { return { platformMessageId: null }; }
  requiresTokenRefresh() { return true; }
  async listNewMessages() { return []; }
  async fetchMessage() { return {} as NormalizedEmail; }
}

describe("EmailProvider", () => {
  const p = new FakeEmail();
  it("default canonicalize lowercases + trims", () => {
    expect(p.canonicalizeAddress("  Jan@Firma.PL ")).toBe("jan@firma.pl");
  });
  it("bodyToText prefers plain, falls back to html→text", () => {
    expect(p.bodyToText("hi", "<b>x</b>")).toBe("hi");
    expect(p.bodyToText(undefined, "<p>Hello <b>world</b></p>")).toContain("Hello world");
  });
});
