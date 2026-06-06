import { relations } from "drizzle-orm/relations";
import { workspaces, conversations, channels, contacts, users, contactChannels, tags, auditLogs, flows, flowTriggers, messages, autoReplyRules, flowSessions, sequences, sequenceEnrollments, broadcasts, broadcastRecipients, commentLogs, flowVersions, apiKeys, pendingApprovals, contactTags, workspaceMembers } from "./schema";

export const conversationsRelations = relations(conversations, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [conversations.workspace_id],
		references: [workspaces.id]
	}),
	channel: one(channels, {
		fields: [conversations.channel_id],
		references: [channels.id]
	}),
	contact: one(contacts, {
		fields: [conversations.contact_id],
		references: [contacts.id]
	}),
	user: one(users, {
		fields: [conversations.assigned_to],
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
		fields: [channels.workspace_id],
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
		fields: [contacts.workspace_id],
		references: [workspaces.id]
	}),
	contact_channels: many(contactChannels),
	flowSessions: many(flowSessions),
	sequenceEnrollments: many(sequenceEnrollments),
	broadcastRecipients: many(broadcastRecipients),
	pendingApprovals: many(pendingApprovals),
	tags: many(contactTags),
}));

export const usersRelations = relations(users, ({many}) => ({
	conversations: many(conversations),
	messages: many(messages),
	workspaceMembers: many(workspaceMembers),
}));

export const contactChannelsRelations = relations(contactChannels, ({one}) => ({
	contact: one(contacts, {
		fields: [contactChannels.contact_id],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [contactChannels.channel_id],
		references: [channels.id]
	}),
}));

export const tagsRelations = relations(tags, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [tags.workspace_id],
		references: [workspaces.id]
	}),
	contactTags: many(contactTags),
}));

export const auditLogsRelations = relations(auditLogs, ({one}) => ({
	workspace: one(workspaces, {
		fields: [auditLogs.workspace_id],
		references: [workspaces.id]
	}),
}));

export const flowsRelations = relations(flows, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [flows.workspace_id],
		references: [workspaces.id]
	}),
	flowTriggers: many(flowTriggers),
	messages: many(messages),
	flowSessions: many(flowSessions),
	flowVersions: many(flowVersions),
}));

export const flowTriggersRelations = relations(flowTriggers, ({one}) => ({
	flow: one(flows, {
		fields: [flowTriggers.flow_id],
		references: [flows.id]
	}),
	channel: one(channels, {
		fields: [flowTriggers.channel_id],
		references: [channels.id]
	}),
}));

export const messagesRelations = relations(messages, ({one}) => ({
	conversation: one(conversations, {
		fields: [messages.conversation_id],
		references: [conversations.id]
	}),
	user: one(users, {
		fields: [messages.sent_by_user_id],
		references: [users.id]
	}),
	autoReplyRule: one(autoReplyRules, {
		fields: [messages.sent_by_rule_id],
		references: [autoReplyRules.id]
	}),
	flow: one(flows, {
		fields: [messages.sent_by_flow_id],
		references: [flows.id]
	}),
}));

export const autoReplyRulesRelations = relations(autoReplyRules, ({one, many}) => ({
	messages: many(messages),
	workspace: one(workspaces, {
		fields: [autoReplyRules.workspace_id],
		references: [workspaces.id]
	}),
	channel: one(channels, {
		fields: [autoReplyRules.channel_id],
		references: [channels.id]
	}),
	pendingApprovals: many(pendingApprovals),
}));

export const flowSessionsRelations = relations(flowSessions, ({one}) => ({
	contact: one(contacts, {
		fields: [flowSessions.contact_id],
		references: [contacts.id]
	}),
	flow: one(flows, {
		fields: [flowSessions.flow_id],
		references: [flows.id]
	}),
	conversation: one(conversations, {
		fields: [flowSessions.conversation_id],
		references: [conversations.id]
	}),
}));

export const sequencesRelations = relations(sequences, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [sequences.workspace_id],
		references: [workspaces.id]
	}),
	sequenceEnrollments: many(sequenceEnrollments),
}));

export const sequenceEnrollmentsRelations = relations(sequenceEnrollments, ({one}) => ({
	sequence: one(sequences, {
		fields: [sequenceEnrollments.sequence_id],
		references: [sequences.id]
	}),
	contact: one(contacts, {
		fields: [sequenceEnrollments.contact_id],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [sequenceEnrollments.channel_id],
		references: [channels.id]
	}),
}));

export const broadcastsRelations = relations(broadcasts, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [broadcasts.workspace_id],
		references: [workspaces.id]
	}),
	broadcastRecipients: many(broadcastRecipients),
}));

export const broadcastRecipientsRelations = relations(broadcastRecipients, ({one}) => ({
	broadcast: one(broadcasts, {
		fields: [broadcastRecipients.broadcast_id],
		references: [broadcasts.id]
	}),
	contact: one(contacts, {
		fields: [broadcastRecipients.contact_id],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [broadcastRecipients.channel_id],
		references: [channels.id]
	}),
}));

export const commentLogsRelations = relations(commentLogs, ({one}) => ({
	channel: one(channels, {
		fields: [commentLogs.channel_id],
		references: [channels.id]
	}),
}));

export const flowVersionsRelations = relations(flowVersions, ({one}) => ({
	flow: one(flows, {
		fields: [flowVersions.flow_id],
		references: [flows.id]
	}),
}));

export const apiKeysRelations = relations(apiKeys, ({one}) => ({
	workspace: one(workspaces, {
		fields: [apiKeys.workspace_id],
		references: [workspaces.id]
	}),
}));

export const pendingApprovalsRelations = relations(pendingApprovals, ({one}) => ({
	workspace: one(workspaces, {
		fields: [pendingApprovals.workspace_id],
		references: [workspaces.id]
	}),
	autoReplyRule: one(autoReplyRules, {
		fields: [pendingApprovals.rule_id],
		references: [autoReplyRules.id]
	}),
	conversation: one(conversations, {
		fields: [pendingApprovals.conversation_id],
		references: [conversations.id]
	}),
	contact: one(contacts, {
		fields: [pendingApprovals.contact_id],
		references: [contacts.id]
	}),
	channel: one(channels, {
		fields: [pendingApprovals.channel_id],
		references: [channels.id]
	}),
}));

export const contactTagsRelations = relations(contactTags, ({one}) => ({
	contact: one(contacts, {
		fields: [contactTags.contact_id],
		references: [contacts.id]
	}),
	tag: one(tags, {
		fields: [contactTags.tag_id],
		references: [tags.id]
	}),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({one}) => ({
	workspace: one(workspaces, {
		fields: [workspaceMembers.workspace_id],
		references: [workspaces.id]
	}),
	user: one(users, {
		fields: [workspaceMembers.user_id],
		references: [users.id]
	}),
}));