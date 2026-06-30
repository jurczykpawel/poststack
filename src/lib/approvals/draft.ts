import type { MessageContent } from "@/lib/platforms/base";

/**
 * The shape stored in `pending_approvals.proposed_content` and consumed by the approve handler:
 * an optional DM body and/or an optional public-comment reply. One canonical type so the rule
 * executor (planApproval), the AI-draft worker, and the approve/send path all agree on it.
 *  - `content` — the DM message (text + interactive add-ons), null/absent when there is no DM part.
 *  - `comment` — a public comment reply addressed to `commentId`, absent when there is no public part.
 */
export interface ProposedContent {
  content?: MessageContent | null;
  comment?: { text?: string; commentId?: string } | null;
}

/**
 * AIDRAFT1: build the `proposed_content` for an AI-drafted reply from a single generated `draftText`,
 * for the channel's configured surface (`target`):
 *  - `dm`     → only a DM body (`content.text`),
 *  - `public` → only a public comment reply (`comment{text, commentId}`) — requires `commentId`,
 *  - `both`   → both parts, sharing the one draft text.
 *
 * The public part is emitted only when a `commentId` is present (a DM-triggered draft has none, so a
 * `public`/`both` target with no comment context yields no comment part — the caller treats an empty
 * result as "nothing to draft"). Mirrors the `{content?, comment?}` shape the rule executor parks.
 */
export function buildProposedContent(args: {
  target: "dm" | "public" | "both";
  draftText: string;
  commentId?: string;
}): ProposedContent {
  const { target, draftText, commentId } = args;
  const proposed: ProposedContent = {};
  if (target === "dm" || target === "both") {
    proposed.content = { text: draftText };
  }
  if ((target === "public" || target === "both") && commentId) {
    proposed.comment = { text: draftText, commentId };
  }
  return proposed;
}

/** Whether a proposed DM part is sendable (has text or an interactive add-on). */
export function proposedHasDm(content?: MessageContent | null): boolean {
  return !!content && (!!content.text || !!content.buttons?.length || !!content.quick_replies?.length);
}

/** Whether a proposed public-comment part is sendable (has both text and the target comment id). */
export function proposedHasComment(comment?: { text?: string; commentId?: string } | null): boolean {
  return !!comment?.text && !!comment?.commentId;
}
