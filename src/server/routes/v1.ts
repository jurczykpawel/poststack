import { Hono } from "hono";
import * as channels from "@/server/handlers/v1/channels/route";
import * as channel from "@/server/handlers/v1/channels/[channelId]/route";
import * as channelDrain from "@/server/handlers/v1/channels/[channelId]/drain/route";
import * as channelPosts from "@/server/handlers/v1/channels/[channelId]/posts/route";
import * as channelConnectToken from "@/server/handlers/v1/channels/connect-token/route";
import * as channelTelegram from "@/server/handlers/v1/channels/telegram/route";
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
import * as approvals from "@/server/handlers/v1/approvals/route";
import * as approvalApprove from "@/server/handlers/v1/approvals/[approvalId]/approve/route";
import * as approvalReject from "@/server/handlers/v1/approvals/[approvalId]/reject/route";

export const v1 = new Hono();

// Channels
v1.get("/channels", (c) => channels.GET(c.req.raw));
v1.post("/channels/connect-token", (c) => channelConnectToken.POST(c.req.raw));
v1.post("/channels/telegram/connect", (c) => channelTelegram.POST(c.req.raw));
v1.get("/channels/:channelId", (c) =>
  channel.GET(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.patch("/channels/:channelId", (c) =>
  channel.PATCH(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.delete("/channels/:channelId", (c) =>
  channel.DELETE(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.post("/channels/:channelId/drain", (c) =>
  channelDrain.POST(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);
v1.get("/channels/:channelId/posts", (c) =>
  channelPosts.GET(c.req.raw, { params: Promise.resolve({ channelId: c.req.param("channelId") }) }),
);

// Managed connections (Meta managed connection — one master token → all Pages + IG)
v1.get("/sources", (c) => sources.GET(c.req.raw));
v1.post("/sources", (c) => sources.POST(c.req.raw));
v1.delete("/sources/:sourceId", (c) =>
  source.DELETE(c.req.raw, { params: Promise.resolve({ sourceId: c.req.param("sourceId") }) }),
);
v1.post("/sources/:sourceId/sync", (c) =>
  sourceSync.POST(c.req.raw, { params: Promise.resolve({ sourceId: c.req.param("sourceId") }) }),
);

// Contacts
v1.get("/contacts", (c) => contacts.GET(c.req.raw));
v1.get("/contacts/:contactId", (c) =>
  contact.GET(c.req.raw, { params: Promise.resolve({ contactId: c.req.param("contactId") }) }),
);
v1.patch("/contacts/:contactId", (c) =>
  contact.PATCH(c.req.raw, { params: Promise.resolve({ contactId: c.req.param("contactId") }) }),
);
v1.delete("/contacts/:contactId", (c) =>
  contact.DELETE(c.req.raw, { params: Promise.resolve({ contactId: c.req.param("contactId") }) }),
);

// Conversations
v1.get("/conversations", (c) => conversations.GET(c.req.raw));
v1.get("/conversations/:conversationId", (c) =>
  conversation.GET(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);
v1.patch("/conversations/:conversationId", (c) =>
  conversation.PATCH(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);
v1.get("/conversations/:conversationId/messages", (c) =>
  conversationMessages.GET(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);
v1.post("/conversations/:conversationId/messages", (c) =>
  conversationMessages.POST(c.req.raw, { params: Promise.resolve({ conversationId: c.req.param("conversationId") }) }),
);

// Rules
v1.get("/rules", (c) => rules.GET(c.req.raw));
v1.post("/rules", (c) => rules.POST(c.req.raw));
v1.get("/rules/:ruleId", (c) =>
  rule.GET(c.req.raw, { params: Promise.resolve({ ruleId: c.req.param("ruleId") }) }),
);
v1.patch("/rules/:ruleId", (c) =>
  rule.PATCH(c.req.raw, { params: Promise.resolve({ ruleId: c.req.param("ruleId") }) }),
);
v1.delete("/rules/:ruleId", (c) =>
  rule.DELETE(c.req.raw, { params: Promise.resolve({ ruleId: c.req.param("ruleId") }) }),
);

// Sequences
v1.get("/sequences", (c) => sequences.GET(c.req.raw));
v1.post("/sequences", (c) => sequences.POST(c.req.raw));
v1.get("/sequences/:sequenceId", (c) =>
  sequence.GET(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.patch("/sequences/:sequenceId", (c) =>
  sequence.PATCH(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.delete("/sequences/:sequenceId", (c) =>
  sequence.DELETE(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.post("/sequences/:sequenceId/enroll", (c) =>
  sequenceEnroll.POST(c.req.raw, { params: Promise.resolve({ sequenceId: c.req.param("sequenceId") }) }),
);
v1.delete("/sequences/:sequenceId/enrollments/:enrollmentId", (c) =>
  sequenceEnrollment.DELETE(c.req.raw, {
    params: Promise.resolve({ sequenceId: c.req.param("sequenceId"), enrollmentId: c.req.param("enrollmentId") }),
  }),
);

// Approvals (human-in-the-loop before send)
v1.get("/approvals", (c) => approvals.GET(c.req.raw));
v1.post("/approvals/:approvalId/approve", (c) =>
  approvalApprove.POST(c.req.raw, { params: Promise.resolve({ approvalId: c.req.param("approvalId") }) }),
);
v1.post("/approvals/:approvalId/reject", (c) =>
  approvalReject.POST(c.req.raw, { params: Promise.resolve({ approvalId: c.req.param("approvalId") }) }),
);

// API keys
v1.get("/api-keys", (c) => apiKeys.GET(c.req.raw));
v1.post("/api-keys", (c) => apiKeys.POST(c.req.raw));
v1.delete("/api-keys/:keyId", (c) =>
  apiKey.DELETE(c.req.raw, { params: Promise.resolve({ keyId: c.req.param("keyId") }) }),
);

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
