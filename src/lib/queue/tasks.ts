import type { TaskList } from "graphile-worker";
import { processIncomingMessage } from "@/lib/workers/incoming-message-worker";
import { processIncomingComment } from "@/lib/workers/incoming-comment-worker";
import { processIncomingReaction } from "@/lib/workers/incoming-reaction-worker";
import { processIncomingPostReaction } from "@/lib/workers/incoming-post-reaction-worker";
import { processOutgoingMessage } from "@/lib/workers/outgoing-message-worker";
import { processOutgoingComment } from "@/lib/workers/outgoing-comment-worker";
import { processOutgoingPrivateReply } from "@/lib/workers/outgoing-private-reply-worker";
import { processFollowGate } from "@/lib/workers/follow-gate-worker";
import { processTokenRefresh } from "@/lib/workers/token-refresh-worker";
import { processSequenceStep } from "@/lib/workers/sequence-step-worker";
import { drainChannel } from "@/lib/channels/drain";
import { resumeChannelEnrollments } from "@/lib/sequences/resume";
import { processPublish } from "@/lib/deliveries/publish-worker";
import type { TaskPayloadMap } from "./types";

/**
 * The graphile-worker task registry. Each task identifier maps to its handler;
 * the payload is cast from `unknown` to its typed shape at this boundary.
 */
export function createTaskList(): TaskList {
  return {
    "incoming-message": (p, h) =>
      processIncomingMessage(p as TaskPayloadMap["incoming-message"], h),
    "incoming-comment": (p, h) =>
      processIncomingComment(p as TaskPayloadMap["incoming-comment"], h),
    "incoming-reaction": (p, h) =>
      processIncomingReaction(p as TaskPayloadMap["incoming-reaction"], h),
    "incoming-post-reaction": (p, h) =>
      processIncomingPostReaction(p as TaskPayloadMap["incoming-post-reaction"], h),
    "outgoing-message": (p, h) =>
      processOutgoingMessage(p as TaskPayloadMap["outgoing-message"], h),
    "outgoing-comment": (p, h) =>
      processOutgoingComment(p as TaskPayloadMap["outgoing-comment"], h),
    "outgoing-private-reply": (p, h) =>
      processOutgoingPrivateReply(p as TaskPayloadMap["outgoing-private-reply"], h),
    "follow-gate": (p, h) =>
      processFollowGate(p as TaskPayloadMap["follow-gate"], h),
    "token-refresh": (p, h) =>
      processTokenRefresh(p as TaskPayloadMap["token-refresh"], h),
    "sequence-step": (p, h) =>
      processSequenceStep(p as TaskPayloadMap["sequence-step"], h),
    "drain-channel": (p) =>
      drainChannel((p as TaskPayloadMap["drain-channel"]).channelId).then(() => undefined),
    "resume-channel-enrollments": (p) =>
      resumeChannelEnrollments((p as TaskPayloadMap["resume-channel-enrollments"]).channelId).then(() => undefined),
    publish: (p, h) => processPublish(p as TaskPayloadMap["publish"], h),
  };
}
