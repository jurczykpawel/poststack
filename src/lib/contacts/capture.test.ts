import { describe, it, expect } from "vitest";
import { extractEmail, extractPhone, captureFieldFromQuickReplies } from "./capture";

describe("extractEmail", () => {
  it("returns a normalized email from a clean reply", () => {
    expect(extractEmail("jan.kowalski@example.com")).toBe("jan.kowalski@example.com");
  });

  it("trims and lowercases", () => {
    expect(extractEmail("  Jan.Kowalski@Example.COM  ")).toBe("jan.kowalski@example.com");
  });

  it("pulls the email out of a longer sentence", () => {
    expect(extractEmail("sure, it's jan@example.com thanks")).toBe("jan@example.com");
  });

  it("returns null when there is no email", () => {
    expect(extractEmail("nope, not telling you")).toBeNull();
    expect(extractEmail("")).toBeNull();
    expect(extractEmail("almost@nope")).toBeNull();
  });
});

describe("extractPhone", () => {
  it("keeps an E.164 number from the Meta profile", () => {
    expect(extractPhone("+48501761834")).toBe("+48501761834");
  });

  it("normalizes spacing and punctuation but keeps a leading +", () => {
    expect(extractPhone("+48 501 761 834")).toBe("+48501761834");
    expect(extractPhone("(48) 501-761-834")).toBe("48501761834");
  });

  it("returns null for too-short or non-numeric junk", () => {
    expect(extractPhone("call me")).toBeNull();
    expect(extractPhone("12345")).toBeNull();
    expect(extractPhone("")).toBeNull();
  });
});

describe("captureFieldFromQuickReplies", () => {
  it("arms email for a user_email quick reply", () => {
    expect(captureFieldFromQuickReplies([{ content_type: "user_email" }])).toBe("email");
  });

  it("arms phone for a user_phone_number quick reply", () => {
    expect(captureFieldFromQuickReplies([{ content_type: "text" }, { content_type: "user_phone_number" }])).toBe("phone");
  });

  it("arms nothing for plain text quick replies or none", () => {
    expect(captureFieldFromQuickReplies([{ content_type: "text" }])).toBeNull();
    expect(captureFieldFromQuickReplies([])).toBeNull();
    expect(captureFieldFromQuickReplies(undefined)).toBeNull();
  });
});
