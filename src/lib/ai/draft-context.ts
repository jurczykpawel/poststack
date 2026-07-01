import { resolvePostContext } from "./post-context";
import { resolveConversationHistory } from "./conversation-history";

/** Join non-empty context pieces with a blank line; `undefined` when none of them produced anything. */
function combineDraftContext(parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((p): p is string => !!p?.trim()).join("\n\n");
  return joined || undefined;
}

/**
 * ADCTX1+ADCTX2+ADCTX3: the full "light context" for an AI-drafted reply — the parent post's caption
 * (comment threads only) and the recent conversation history — as ONE string. This is the single
 * function BOTH the on-demand "Generate reply" button (dashboard.ts) and the automatic no-match
 * pipeline (rules/executor.ts) call, so the two paths can never build context differently.
 */
export async function buildDraftContext(args: {
  workspaceId: string;
  channelId: string;
  conversationId: string;
  isComment: boolean;
  postId?: string;
}): Promise<string | undefined> {
  const caption = args.isComment
    ? await resolvePostContext(args.workspaceId, args.channelId, args.postId)
    : undefined;
  // Labeled so the model can't mistake the post caption for the customer's own message (ADCTX4).
  const postContext = caption ? `Post caption: ${caption}` : undefined;
  const history = await resolveConversationHistory(args.conversationId, args.isComment);
  return combineDraftContext([postContext, history]);
}
