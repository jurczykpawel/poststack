import { z } from "zod";

export const REPLY_TEXT_MAX_LENGTH = 2000;
export const replyText = z.string().trim()
  .min(1, "Reply text is required")
  .max(REPLY_TEXT_MAX_LENGTH, `Reply text must be at most ${REPLY_TEXT_MAX_LENGTH} characters`);
