import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTCHA_HMAC, encodeCaptcha, solvedCaptcha } from "../../../tests/fixtures/captcha";

vi.mock("@/lib/settings/config", () => ({ getConfig: vi.fn() }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn() }));
import { getConfig } from "@/lib/settings/config";
import { rateLimit } from "@/lib/api/rate-limit";
import { verifyCaptcha } from "./verify";

beforeEach(() => {
  vi.mocked(getConfig).mockResolvedValue(CAPTCHA_HMAC);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ allowed: true, remaining: 0, retryAfter: 3600 });
});

describe("captcha solutions", () => {
  it("accepts a v2 solution and consumes its challenge signature", async () => {
    const payload = await solvedCaptcha();
    expect(await verifyCaptcha(encodeCaptcha(payload))).toEqual({ success: true });
    expect(rateLimit).toHaveBeenCalledWith(`altcha:${payload.challenge.signature}`, 1, 3600);
  });

  it("rejects a second use", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 3600 });
    expect((await verifyCaptcha(encodeCaptcha(await solvedCaptcha()))).success).toBe(false);
  });

  it("rejects a wrong solution for a valid signed challenge", async () => {
    const payload = await solvedCaptcha();
    payload.solution.counter += 1;
    expect((await verifyCaptcha(encodeCaptcha(payload))).success).toBe(false);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("rejects expired challenges", async () => {
    expect((await verifyCaptcha(encodeCaptcha(await solvedCaptcha(new Date(Date.now() - 1000))))).success).toBe(false);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("rejects changed parameters", async () => {
    const payload = await solvedCaptcha();
    payload.challenge.parameters.expiresAt! += 3600;
    expect((await verifyCaptcha(encodeCaptcha(payload))).success).toBe(false);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "!", encodeCaptcha(null), encodeCaptcha({}), "x".repeat(8193)])("rejects an invalid payload (%#)", async (payload) => {
    expect((await verifyCaptcha(payload)).success).toBe(false);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("allows forms when captcha is unconfigured", async () => {
    vi.mocked(getConfig).mockResolvedValue("");
    expect(await verifyCaptcha(null)).toEqual({ success: true });
  });
});
