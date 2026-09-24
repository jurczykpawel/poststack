/**
 * Partial contract check for the Instagram send endpoint without a real recipient (VPROBE2).
 *
 * The live version probe cannot always obtain an IGSID with an open messaging window (test apps are
 * locked to Development mode and expose no conversations). Instead it sends the production payload to
 * a recipient that cannot exist; nothing is delivered.
 *
 * What a "recipient not found" answer proves (measured 2026-09-24): the endpoint exists on the target
 * version and host, the token is accepted, and every key we send is still known (unknown keys are
 * rejected with "Invalid keys" BEFORE the recipient lookup).
 *
 * What it does NOT prove: Meta checks the recipient before required fields — a body with no `message`
 * at all still returns "recipient not found" — so a newly required field, a changed success response
 * or a delivery problem stays invisible. The probe therefore reports this as partial coverage and the
 * version-bump PR keeps a mandatory manual real-DM check.
 */

/** A recipient id that no Instagram user can have. */
export const IG_PROBE_UNKNOWN_RECIPIENT_ID = "1";

/** graph.instagram.com rejection for an unknown recipient (measured on v25.0 and v26.0). */
const IG_UNKNOWN_RECIPIENT = { status: 400, code: 100, subcode: 2534014 } as const;

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
}

/** `undefined` when the response is the expected recipient-not-found rejection, else the reason it is not. */
export function unknownRecipientProblem(status: number, json: unknown): string | undefined {
  if (status >= 200 && status < 300) {
    return "send was accepted for a recipient that cannot exist — recipient validation changed";
  }
  const err = (json as { error?: GraphError } | null)?.error;
  if (!err) return `HTTP ${status} without a Graph error body`;
  const { status: s, code, subcode } = IG_UNKNOWN_RECIPIENT;
  if (status === s && err.code === code && err.error_subcode === subcode) return undefined;
  const got = `code ${err.code ?? "?"}${err.error_subcode !== undefined ? ` / subcode ${err.error_subcode}` : ""}`;
  return `expected HTTP ${s} code ${code} / subcode ${subcode} (recipient not found), got HTTP ${status} ${got}: ${err.message ?? ""}`.trim();
}
