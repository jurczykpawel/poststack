import { Hono, type MiddlewareHandler } from "hono";
import { authenticate } from "@/lib/auth";
import { isUuid } from "@/lib/api/identifiers";
import { ApiErrors } from "@/lib/api/response";
import * as channels from "@/server/handlers/v1/channels/route";
import * as channel from "@/server/handlers/v1/channels/[channelId]/route";
import * as channelDrain from "@/server/handlers/v1/channels/[channelId]/drain/route";
import * as tiktokCreatorInfo from "@/server/handlers/v1/channels/[channelId]/tiktok/creator-info/route";
import * as channelPosts from "@/server/handlers/v1/channels/[channelId]/posts/route";
import * as channelConnectToken from "@/server/handlers/v1/channels/connect-token/route";
import * as channelTelegram from "@/server/handlers/v1/channels/telegram/route";
import * as channelGmailFilter from "@/server/handlers/v1/channels/gmail-filter/route";
import * as sources from "@/server/handlers/v1/sources/route";
import * as source from "@/server/handlers/v1/sources/[sourceId]/route";
import * as sourceSync from "@/server/handlers/v1/sources/[sourceId]/sync/route";
import * as contacts from "@/server/handlers/v1/contacts/route";
import * as contact from "@/server/handlers/v1/contacts/[contactId]/route";
import * as conversations from "@/server/handlers/v1/conversations/route";
import * as conversation from "@/server/handlers/v1/conversations/[conversationId]/route";
import * as conversationMessages from "@/server/handlers/v1/conversations/[conversationId]/messages/route";
import * as rules from "@/server/handlers/v1/rules/route";
import * as rule from "@/server/handlers/v1/rules/[ruleId]/route";
import * as sequences from "@/server/handlers/v1/sequences/route";
import * as sequence from "@/server/handlers/v1/sequences/[sequenceId]/route";
import * as sequenceEnroll from "@/server/handlers/v1/sequences/[sequenceId]/enroll/route";
import * as sequenceEnrollment from "@/server/handlers/v1/sequences/[sequenceId]/enrollments/[enrollmentId]/route";
import * as apiKeys from "@/server/handlers/v1/api-keys/route";
import * as apiKey from "@/server/handlers/v1/api-keys/[keyId]/route";
import * as auditLog from "@/server/handlers/v1/audit-log/route";
import * as messagesPrune from "@/server/handlers/v1/messages/prune/route";
import * as webhookEventsPrune from "@/server/handlers/v1/webhook-events/prune/route";
import * as workspace from "@/server/handlers/v1/workspace/route";
import * as license from "@/server/handlers/v1/license/route";
import * as tags from "@/server/handlers/v1/tags/route";
import * as tag from "@/server/handlers/v1/tags/[tagId]/route";
import * as approvals from "@/server/handlers/v1/approvals/route";
import * as approvalApprove from "@/server/handlers/v1/approvals/[approvalId]/approve/route";
import * as approvalReject from "@/server/handlers/v1/approvals/[approvalId]/reject/route";
import * as contentList from "@/server/handlers/v1/content/route";
import * as contentItem from "@/server/handlers/v1/content/[contentId]/route";
import * as postsList from "@/server/handlers/v1/posts/route";
import * as postItem from "@/server/handlers/v1/posts/[postId]/route";
import * as postPublish from "@/server/handlers/v1/posts/[postId]/publish/route";
import * as mediaRegister from "@/server/handlers/v1/media/route";
import * as brandsList from "@/server/handlers/v1/brands/route";
import * as brandItem from "@/server/handlers/v1/brands/[brandKey]/route";
import * as brandChannels from "@/server/handlers/v1/brands/[brandKey]/channels/route";
import * as statsResponseTimes from "@/server/handlers/v1/stats/response-times/route";
import * as webhooksList from "@/server/handlers/v1/webhooks/route";
import * as webhookItem from "@/server/handlers/v1/webhooks/[webhookId]/route";
import * as webhookRotate from "@/server/handlers/v1/webhooks/[webhookId]/rotate-secret/route";

export const v1 = new Hono();

const validateIds: MiddlewareHandler = async (c, next) => {
  for (const [name, value] of Object.entries(c.req.param())) {
    if (name.endsWith("Id") && !isUuid(value)) {
      if (!await authenticate(c.req.raw).catch(() => null)) return ApiErrors.unauthorized();
      return ApiErrors.notFound();
    }
  }
  await next();
};

// Channels
v1.get("/channels", (c) => channels.GET(c.req.raw));
v1.post("/channels/connect-token", (c) => channelConnectToken.POST(c.req.raw));
v1.post("/channels/telegram/connect", (c) => channelTelegram.POST(c.req.raw));
v1.post("/channels/:channelId/gmail-filter", validateIds, (c) =>
  channelGmailFilter.POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("channelId") }) }),
);
v1.get("/channels/:channelId", validateIds, (c) =>
  channel.GET(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.patch("/channels/:channelId", validateIds, (c) =>
  channel.PATCH(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.delete("/channels/:channelId", validateIds, (c) =>
  channel.DELETE(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.post("/channels/:channelId/drain", validateIds, (c) =>
  channelDrain.POST(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.get("/channels/:channelId/posts", validateIds, (c) =>
  channelPosts.GET(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);

v1.get("/channels/:channelId/tiktok/creator-info", validateIds, (c) =>
  tiktokCreatorInfo.GET(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);

// Managed connections (Meta managed connection — one master token → all Pages + IG)
v1.get("/sources", (c) => sources.GET(c.req.raw));
v1.post("/sources", (c) => sources.POST(c.req.raw));
v1.delete("/sources/:sourceId", validateIds, (c) =>
  source.DELETE(c.req.raw, { params: Promise.resolve({ sourceId: c.req.param("sourceId") }) }),
);
v1.post("/sources/:sourceId/sync", validateIds, (c) =>
  sourceSync.POST(c.req.raw, { params: Promise.resolve({ sourceId: c.req.param("sourceId") }) }),
);

// Contacts
v1.get("/contacts", (c) => contacts.GET(c.req.raw));
v1.post("/contacts", (c) => contacts.POST(c.req.raw));
v1.get("/contacts/:contactId", validateIds, (c) =>
  contact.GET(c.req.raw, { params: Promise.resolve({ contactId: c.req.param("contactId") }) }),
);
v1.patch("/contacts/:contactId", validateIds, (c) =>
  contact.PATCH(c.req.raw, { params: Promise.resolve({ contactId: c.req.param("contactId") }) }),
);
v1.delete("/contacts/:contactId", validateIds, (c) =>
  contact.DELETE(c.req.raw, { params: Promise.resolve({ contactId: c.req.param("contactId") }) }),
);

// Conversations
v1.get("/conversations", (c) => conversations.GET(c.req.raw));
v1.get("/conversations/:conversationId", validateIds, (c) =>
  conversation.GET(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);
v1.patch("/conversations/:conversationId", validateIds, (c) =>
  conversation.PATCH(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);
v1.get("/conversations/:conversationId/messages", validateIds, (c) =>
  conversationMessages.GET(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);
v1.post("/conversations/:conversationId/messages", validateIds, (c) =>
  conversationMessages.POST(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);

// Rules
v1.get("/rules", (c) => rules.GET(c.req.raw));
v1.post("/rules", (c) => rules.POST(c.req.raw));
v1.get("/rules/:ruleId", validateIds, (c) =>
  rule.GET(c.req.raw, { params: Promise.resolve({ ruleId: c.req.param("ruleId") }) }),
);
v1.patch("/rules/:ruleId", validateIds, (c) =>
  rule.PATCH(c.req.raw, { params: Promise.resolve({ ruleId: c.req.param("ruleId") }) }),
);
v1.delete("/rules/:ruleId", validateIds, (c) =>
  rule.DELETE(c.req.raw, { params: Promise.resolve({ ruleId: c.req.param("ruleId") }) }),
);

// Sequences
v1.get("/sequences", (c) => sequences.GET(c.req.raw));
v1.post("/sequences", (c) => sequences.POST(c.req.raw));
v1.get("/sequences/:sequenceId", validateIds, (c) =>
  sequence.GET(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.patch("/sequences/:sequenceId", validateIds, (c) =>
  sequence.PATCH(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.delete("/sequences/:sequenceId", validateIds, (c) =>
  sequence.DELETE(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.post("/sequences/:sequenceId/enroll", validateIds, (c) =>
  sequenceEnroll.POST(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.delete("/sequences/:sequenceId/enrollments/:enrollmentId", validateIds, (c) =>
  sequenceEnrollment.DELETE(c.req.raw, {
    params: Promise.resolve({ sequenceId: c.req.param("sequenceId"), enrollmentId: c.req.param("enrollmentId") }),
  }),
);

// Approvals (human-in-the-loop before send)
v1.get("/approvals", (c) => approvals.GET(c.req.raw));
v1.post("/approvals/:approvalId/approve", validateIds, (c) =>
  approvalApprove.POST(c.req.raw, { params: Promise.resolve({ approvalId: c.req.param("approvalId") }) }),
);
v1.post("/approvals/:approvalId/reject", validateIds, (c) =>
  approvalReject.POST(c.req.raw, { params: Promise.resolve({ approvalId: c.req.param("approvalId") }) }),
);

// API keys
v1.get("/api-keys", (c) => apiKeys.GET(c.req.raw));
v1.post("/api-keys", (c) => apiKeys.POST(c.req.raw));
v1.delete("/api-keys/:keyId", validateIds, (c) =>
  apiKey.DELETE(c.req.raw, { params: Promise.resolve({ keyId: c.req.param("keyId") }) }),
);

// Stats
v1.get("/stats/response-times", (c) => statsResponseTimes.GET(c.req.raw));

// Audit log, retention, workspace, tags
v1.get("/audit-log", (c) => auditLog.GET(c.req.raw));
v1.post("/messages/prune", (c) => messagesPrune.POST(c.req.raw));
v1.post("/webhook-events/prune", (c) => webhookEventsPrune.POST(c.req.raw));
v1.get("/workspace", (c) => workspace.GET(c.req.raw));
v1.patch("/workspace", (c) => workspace.PATCH(c.req.raw));
v1.get("/license", (c) => license.GET(c.req.raw));
v1.post("/license", (c) => license.POST(c.req.raw));
v1.delete("/license", (c) => license.DELETE(c.req.raw));
v1.get("/tags", (c) => tags.GET(c.req.raw));
v1.post("/tags", (c) => tags.POST(c.req.raw));
v1.patch("/tags/:tagId", validateIds, (c) =>
  tag.PATCH(c.req.raw, { params: Promise.resolve({ tagId: c.req.param("tagId") }) }),
);
v1.delete("/tags/:tagId", validateIds, (c) =>
  tag.DELETE(c.req.raw, { params: Promise.resolve({ tagId: c.req.param("tagId") }) }),
);

// ── Publishing: editorial content + posts + media + brands ──────────────────────
v1.get("/content", (c) => contentList.GET(c.req.raw));
v1.post("/content", (c) => contentList.POST(c.req.raw));
v1.get("/content/:contentId", validateIds, (c) =>
  contentItem.GET(c.req.raw, { params: Promise.resolve({ contentId: c.req.param("contentId") }) }),
);
v1.patch("/content/:contentId", validateIds, (c) =>
  contentItem.PATCH(c.req.raw, { params: Promise.resolve({ contentId: c.req.param("contentId") }) }),
);
v1.delete("/content/:contentId", validateIds, (c) =>
  contentItem.DELETE(c.req.raw, { params: Promise.resolve({ contentId: c.req.param("contentId") }) }),
);
v1.get("/posts", (c) => postsList.GET(c.req.raw));
v1.post("/posts", (c) => postsList.POST(c.req.raw));
v1.get("/posts/:postId", validateIds, (c) =>
  postItem.GET(c.req.raw, { params: Promise.resolve({ postId: c.req.param("postId") }) }),
);
v1.patch("/posts/:postId", validateIds, (c) =>
  postItem.PATCH(c.req.raw, { params: Promise.resolve({ postId: c.req.param("postId") }) }),
);
v1.delete("/posts/:postId", validateIds, (c) =>
  postItem.DELETE(c.req.raw, { params: Promise.resolve({ postId: c.req.param("postId") }) }),
);
v1.post("/posts/:postId/publish", validateIds, (c) =>
  postPublish.POST(c.req.raw, { params: Promise.resolve({ postId: c.req.param("postId") }) }),
);
v1.post("/media", (c) => mediaRegister.POST(c.req.raw));
v1.get("/brands", (c) => brandsList.GET(c.req.raw));
v1.post("/brands", (c) => brandsList.POST(c.req.raw));
v1.get("/brands/:brandKey/channels", validateIds, (c) =>
  brandChannels.GET(c.req.raw, { params: Promise.resolve({ brandKey: c.req.param("brandKey") }) }),
);
v1.patch("/brands/:brandKey", validateIds, (c) =>
  brandItem.PATCH(c.req.raw, { params: Promise.resolve({ brandKey: c.req.param("brandKey") }) }),
);
v1.delete("/brands/:brandKey", validateIds, (c) =>
  brandItem.DELETE(c.req.raw, { params: Promise.resolve({ brandKey: c.req.param("brandKey") }) }),
);

// Outbound webhooks (WHOUT1)
v1.get("/webhooks", (c) => webhooksList.GET(c.req.raw));
v1.post("/webhooks", (c) => webhooksList.POST(c.req.raw));
v1.get("/webhooks/:webhookId", validateIds, (c) =>
  webhookItem.GET(c.req.raw, { params: Promise.resolve({ webhookId: c.req.param("webhookId") }) }),
);
v1.patch("/webhooks/:webhookId", validateIds, (c) =>
  webhookItem.PATCH(c.req.raw, { params: Promise.resolve({ webhookId: c.req.param("webhookId") }) }),
);
v1.delete("/webhooks/:webhookId", validateIds, (c) =>
  webhookItem.DELETE(c.req.raw, { params: Promise.resolve({ webhookId: c.req.param("webhookId") }) }),
);
v1.post("/webhooks/:webhookId/rotate-secret", validateIds, (c) =>
  webhookRotate.POST(c.req.raw, { params: Promise.resolve({ webhookId: c.req.param("webhookId") }) }),
);
