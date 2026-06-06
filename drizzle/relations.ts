import { relations } from "drizzle-orm/relations";
import { workspaces, conversations, channels, contacts, users, contactChannels, tags, auditLogs, flows, flowTriggers, messages, autoReplyRules, flowSessions, sequences, sequenceEnrollments, broadcasts, broadcastRecipients, commentLogs, flowVersions, apiKeys, pendingApprovals, contactTags, workspaceMembers } from "./schema";

export const conversationsRelations = relations(conversations, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [conversations.workspaceId],
		references: [workspaces.id]
	}),
	channel: one(channels, {
		fields: [conversations.channelId],
		references: [channels.id]
	}),
	contact: one(contacts, {
		fields: [conversations.contactId],
		references: [contacts.id]
	}),
	user: one(users, {
		fields: [conversations.assignedTo],
		references: [users.id]
	}),
	messages: many(messages),
	flowSessions: many(flowSessions),
	pendingApprovals: many(pendingApprovals),
}));

export const workspacesRelations = relations(workspaces, ({many}) => ({
	conversations: many(conversations),
	channels: many(channels),
	contacts: many(contacts),
	tags: many(tags),
	auditLogs: many(auditLogs),
	flows: many(flows),
	sequences: many(sequences),
	broadcasts: many(broadcasts),
	apiKeys: many(apiKeys),
	autoReplyRules: many(autoReplyRules),
	pendingApprovals: many(pendingApprovals),
	workspaceMembers: many(workspaceMembers),
}));

export const channelsRelations = relations(channels, ({one, many}) => ({
	conversations: many(conversations),
	workspace: one(workspaces, {
		fields: [channels.workspaceId],
		references: [workspaces.id]
	}),
	contactChannels: many(contactChannels),
	flowTriggers: many(flowTriggers),
	sequenceEnrollments: many(sequenceEnrollments),
	broadcastRecipients: many(broadcastRecipients),
	commentLogs: many(commentLogs),
	autoReplyRules: many(autoReplyRules),
	pendingApprovals: many(pendingApprovals),
}));

export const contactsRelations = relations(contacts, ({one, many}) => ({
	conversations: many(conversations),
	workspace: one(workspaces, {
		fields: [contacts.workspaceId],
		references: [workspaces.id]
	}),
	contactChannels: many(contactChannels),
	flowSessions: many(flowSessions),
	sequenceEnrollments: many(sequenceEnrollments),
	broadcastRecipients: many(broadcastRecipients),
	pendingApprovals: many(pendingApprovals),
	contactTags: many(contactTags),
}));

export const usersRelations = relations(users, ({many}) => ({
	conversations: many(conversations),
	messages: many(messages),
	workspaceMembers: many(workspaceMembers),
}));

export const contactChannelsRelations = relations(contactChannels, ({one}) => ({
	contact: one(contacts, {
		fields: [contactChannels.contactId],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [contactChannels.channelId],
		references: [channels.id]
	}),
}));

export const tagsRelations = relations(tags, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [tags.workspaceId],
		references: [workspaces.id]
	}),
	contactTags: many(contactTags),
}));

export const auditLogsRelations = relations(auditLogs, ({one}) => ({
	workspace: one(workspaces, {
		fields: [auditLogs.workspaceId],
		references: [workspaces.id]
	}),
}));

export const flowsRelations = relations(flows, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [flows.workspaceId],
		references: [workspaces.id]
	}),
	flowTriggers: many(flowTriggers),
	messages: many(messages),
	flowSessions: many(flowSessions),
	flowVersions: many(flowVersions),
}));

export const flowTriggersRelations = relations(flowTriggers, ({one}) => ({
	flow: one(flows, {
		fields: [flowTriggers.flowId],
		references: [flows.id]
	}),
	channel: one(channels, {
		fields: [flowTriggers.channelId],
		references: [channels.id]
	}),
}));

export const messagesRelations = relations(messages, ({one}) => ({
	conversation: one(conversations, {
		fields: [messages.conversationId],
		references: [conversations.id]
	}),
	user: one(users, {
		fields: [messages.sentByUserId],
		references: [users.id]
	}),
	autoReplyRule: one(autoReplyRules, {
		fields: [messages.sentByRuleId],
		references: [autoReplyRules.id]
	}),
	flow: one(flows, {
		fields: [messages.sentByFlowId],
		references: [flows.id]
	}),
}));

export const autoReplyRulesRelations = relations(autoReplyRules, ({one, many}) => ({
	messages: many(messages),
	workspace: one(workspaces, {
		fields: [autoReplyRules.workspaceId],
		references: [workspaces.id]
	}),
	channel: one(channels, {
		fields: [autoReplyRules.channelId],
		references: [channels.id]
	}),
	pendingApprovals: many(pendingApprovals),
}));

export const flowSessionsRelations = relations(flowSessions, ({one}) => ({
	contact: one(contacts, {
		fields: [flowSessions.contactId],
		references: [contacts.id]
	}),
	flow: one(flows, {
		fields: [flowSessions.flowId],
		references: [flows.id]
	}),
	conversation: one(conversations, {
		fields: [flowSessions.conversationId],
		references: [conversations.id]
	}),
}));

export const sequencesRelations = relations(sequences, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [sequences.workspaceId],
		references: [workspaces.id]
	}),
	sequenceEnrollments: many(sequenceEnrollments),
}));

export const sequenceEnrollmentsRelations = relations(sequenceEnrollments, ({one}) => ({
	sequence: one(sequences, {
		fields: [sequenceEnrollments.sequenceId],
		references: [sequences.id]
	}),
	contact: one(contacts, {
		fields: [sequenceEnrollments.contactId],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [sequenceEnrollments.channelId],
		references: [channels.id]
	}),
}));

export const broadcastsRelations = relations(broadcasts, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [broadcasts.workspaceId],
		references: [workspaces.id]
	}),
	broadcastRecipients: many(broadcastRecipients),
}));

export const broadcastRecipientsRelations = relations(broadcastRecipients, ({one}) => ({
	broadcast: one(broadcasts, {
		fields: [broadcastRecipients.broadcastId],
		references: [broadcasts.id]
	}),
	contact: one(contacts, {
		fields: [broadcastRecipients.contactId],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [broadcastRecipients.channelId],
		references: [channels.id]
	}),
}));

export const commentLogsRelations = relations(commentLogs, ({one}) => ({
	channel: one(channels, {
		fields: [commentLogs.channelId],
		references: [channels.id]
	}),
}));

export const flowVersionsRelations = relations(flowVersions, ({one}) => ({
	flow: one(flows, {
		fields: [flowVersions.flowId],
		references: [flows.id]
	}),
}));

export const apiKeysRelations = relations(apiKeys, ({one}) => ({
	workspace: one(workspaces, {
		fields: [apiKeys.workspaceId],
		references: [workspaces.id]
	}),
}));

export const pendingApprovalsRelations = relations(pendingApprovals, ({one}) => ({
	workspace: one(workspaces, {
		fields: [pendingApprovals.workspaceId],
		references: [workspaces.id]
	}),
	autoReplyRule: one(autoReplyRules, {
		fields: [pendingApprovals.ruleId],
		references: [autoReplyRules.id]
	}),
	conversation: one(conversations, {
		fields: [pendingApprovals.conversationId],
		references: [conversations.id]
	}),
	contact: one(contacts, {
		fields: [pendingApprovals.contactId],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [pendingApprovals.channelId],
		references: [channels.id]
	}),
}));

export const contactTagsRelations = relations(contactTags, ({one}) => ({
	contact: one(contacts, {
		fields: [contactTags.contactId],
		references: [contacts.id]
	}),
	tag: one(tags, {
		fields: [contactTags.tagId],
		references: [tags.id]
	}),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({one}) => ({
	workspace: one(workspaces, {
		fields: [workspaceMembers.workspaceId],
		references: [workspaces.id]
	}),
	user: one(users, {
		fields: [workspaceMembers.userId],
		references: [users.id]
	}),
}));