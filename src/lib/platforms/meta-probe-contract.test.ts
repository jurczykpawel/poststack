import { describe, it, expect } from "vitest";
import { unknownRecipientProblem } from "./meta-probe-contract";

// Error bodies below are the real graph.instagram.com responses measured on 2026-09-24 (v25.0 and
// v26.0) for POST /me/messages with a non-existent recipient; see VPROBE2.
const notFound = {
  error: { message: "Nie można znaleźć użytkownika, którego dotyczy prośba.", type: "IGApiException", code: 100, error_subcode: 2534014 },
};

describe("unknownRecipientProblem", () => {
  it("accepts the recipient-not-found rejection: endpoint and payload were understood", () => {
    expect(unknownRecipientProblem(400, notFound)).toBeUndefined();
  });

  it("flags a payload-shape rejection (Meta renamed or dropped a key we send)", () => {
    const invalidKeys = { error: { message: 'Invalid keys "txt" were found in param "message".', type: "IGApiException", code: 100 } };
    expect(unknownRecipientProblem(400, invalidKeys)).toMatch(/Invalid keys/);
  });

  it("flags an unsupported edge (the send endpoint moved or was removed)", () => {
    const unsupported = { error: { message: "Unsupported post request.", type: "IGApiException", code: 100, error_subcode: 33 } };
    expect(unknownRecipientProblem(400, unsupported)).toMatch(/subcode 33/);
  });

  it("flags an unknown version/path", () => {
    const unknownPath = { error: { message: "Unknown path components: /messages", type: "IGApiException", code: 2500 } };
    expect(unknownRecipientProblem(400, unknownPath)).toMatch(/code 2500/);
  });

  it("flags a send that was accepted for a recipient that cannot exist", () => {
    expect(unknownRecipientProblem(200, { message_id: "m1" })).toMatch(/accepted/i);
  });

  it("flags a non-JSON or unexpected status", () => {
    expect(unknownRecipientProblem(500, null)).toMatch(/HTTP 500/);
  });
});
