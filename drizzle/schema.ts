import { pgTable, varchar, timestamp, text, integer, uniqueIndex, index, foreignKey, uuid, boolean, jsonb, primaryKey, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const approvalStatus = pgEnum("approval_status", ['pending', 'approved', 'rejected'])
export const auditActorType = pgEnum("audit_actor_type", ['user', 'api_key', 'system'])
export const broadcastRecipientStatus = pgEnum("broadcast_recipient_status", ['pending', 'sent', 'delivered', 'failed'])
export const broadcastStatus = pgEnum("broadcast_status", ['draft', 'scheduled', 'sending', 'completed', 'cancelled'])
export const channelConnectionMode = pgEnum("channel_connection_mode", ['oauth', 'manual_token'])
export const channelStatus = pgEnum("channel_status", ['active', 'needs_reauth', 'paused', 'disabled'])
export const conversationStatus = pgEnum("conversation_status", ['open', 'closed', 'snoozed'])
export const flowSessionStatus = pgEnum("flow_session_status", ['active', 'completed', 'expired', 'cancelled'])
export const flowStatus = pgEnum("flow_status", ['draft', 'published', 'archived'])
export const messageDirection = pgEnum("message_direction", ['inbound', 'outbound'])
export const messageStatus = pgEnum("message_status", ['pending', 'sent', 'delivered', 'failed', 'held', 'expired'])
export const platform = pgEnum("platform", ['facebook', 'instagram', 'telegram', 'tiktok', 'twitter', 'gmail', 'discord'])
export const responseType = pgEnum("response_type", ['text', 'random_text', 'sequence', 'none', 'ai_rephrase'])
export const sequenceEnrollmentStatus = pgEnum("sequence_enrollment_status", ['active', 'paused', 'completed', 'cancelled'])
export const sequenceStatus = pgEnum("sequence_status", ['draft', 'active', 'archived'])
export const triggerType = pgEnum("trigger_type", ['keyword', 'comment_keyword', 'postback', 'welcome', 'default', 'story_reply', 'story_mention'])
export const workspaceMemberRole = pgEnum("workspace_member_role", ['owner', 'admin', 'agent'])


export const prismaMigrations = pgTable("_prisma_migrations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	checksum: varchar({ length: 64 }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	migrationName: varchar("migration_name", { length: 255 }).notNull(),
	logs: text(),
	rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	appliedStepsCount: integer("applied_steps_count").default(0).notNull(),
});

export const conversations = pgTable("conversations", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	platform: platform().notNull(),
	platformConversationId: text("platform_conversation_id"),
	status: conversationStatus().default('open').notNull(),
	assignedTo: uuid("assigned_to"),
	lastMessageAt: timestamp("last_message_at", { precision: 3, mode: 'string' }),
	lastMessagePreview: text("last_message_preview"),
	unreadCount: integer("unread_count").default(0).notNull(),
	isAutomationPaused: boolean("is_automation_paused").default(false).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
	needsManualReply: boolean("needs_manual_reply").default(false).notNull(),
	lastInboundAt: timestamp("last_inbound_at", { precision: 3, mode: 'string' }),
}, (table) => [
	uniqueIndex("conversations_channel_id_contact_id_key").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops")),
	index("conversations_workspace_id_last_message_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.lastMessageAt.desc().nullsFirst().op("timestamp_ops")),
	index("conversations_workspace_id_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "conversations_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "conversations_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "conversations_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.assignedTo],
			foreignColumns: [users.id],
			name: "conversations_assigned_to_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const channels = pgTable("channels", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	platform: platform().notNull(),
	platformId: text("platform_id").notNull(),
	displayName: text("display_name"),
	username: text(),
	profilePicture: text("profile_picture"),
	tokenEncrypted: text("token_encrypted").notNull(),
	webhookSecret: text("webhook_secret").notNull(),
	lastCommentCursor: text("last_comment_cursor"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
	lastError: text("last_error"),
	lastHealthAt: timestamp("last_health_at", { precision: 3, mode: 'string' }),
	status: channelStatus().default('active').notNull(),
	connectionMode: channelConnectionMode("connection_mode").default('oauth').notNull(),
}, (table) => [
	index("channels_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("channels_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("channels_workspace_id_platform_id_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.platformId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "channels_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const workspaces = pgTable("workspaces", {
	id: uuid().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
	messageRetentionDays: integer("message_retention_days"),
}, (table) => [
	uniqueIndex("workspaces_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
]);

export const users = pgTable("users", {
	id: uuid().primaryKey().notNull(),
	email: text().notNull(),
	passwordHash: text("password_hash"),
	name: text(),
	avatarUrl: text("avatar_url"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("users_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
]);

export const contacts = pgTable("contacts", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	displayName: text("display_name"),
	email: text(),
	avatarUrl: text("avatar_url"),
	isSubscribed: boolean("is_subscribed").default(true).notNull(),
	lastInteractionAt: timestamp("last_interaction_at", { precision: 3, mode: 'string' }),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("contacts_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("contacts_workspace_id_last_interaction_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamp_ops"), table.lastInteractionAt.desc().nullsFirst().op("timestamp_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "contacts_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const contactChannels = pgTable("contact_channels", {
	id: uuid().primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	platformSenderId: text("platform_sender_id").notNull(),
	platformUsername: text("platform_username"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("contact_channels_channel_id_platform_sender_id_key").using("btree", table.channelId.asc().nullsLast().op("text_ops"), table.platformSenderId.asc().nullsLast().op("text_ops")),
	index("contact_channels_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_channels_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "contact_channels_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const tags = pgTable("tags", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	color: text().default('#6366f1').notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("tags_workspace_id_name_key").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "tags_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const auditLogs = pgTable("audit_logs", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	actorType: auditActorType("actor_type").notNull(),
	actorId: text("actor_id"),
	action: text().notNull(),
	targetType: text("target_type"),
	targetId: text("target_id"),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("audit_logs_workspace_id_created_at_idx").using("btree", table.workspaceId.asc().nullsLast().op("timestamp_ops"), table.createdAt.desc().nullsFirst().op("timestamp_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "audit_logs_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const flows = pgTable("flows", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	description: text(),
	status: flowStatus().default('draft').notNull(),
	nodes: jsonb().default([]).notNull(),
	edges: jsonb().default([]).notNull(),
	viewport: jsonb(),
	version: integer().default(1).notNull(),
	publishedAt: timestamp("published_at", { precision: 3, mode: 'string' }),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("flows_workspace_id_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "flows_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const flowTriggers = pgTable("flow_triggers", {
	id: uuid().primaryKey().notNull(),
	flowId: uuid("flow_id").notNull(),
	channelId: uuid("channel_id"),
	type: triggerType().notNull(),
	config: jsonb().default({}).notNull(),
	priority: integer().default(0).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("flow_triggers_channel_id_type_is_active_idx").using("btree", table.channelId.asc().nullsLast().op("enum_ops"), table.type.asc().nullsLast().op("bool_ops"), table.isActive.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_triggers_flow_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "flow_triggers_channel_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const messages = pgTable("messages", {
	id: uuid().primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	direction: messageDirection().notNull(),
	text: text(),
	attachments: jsonb(),
	quickReplyPayload: text("quick_reply_payload"),
	postbackPayload: text("postback_payload"),
	platformMessageId: text("platform_message_id"),
	sentByRuleId: uuid("sent_by_rule_id"),
	sentByFlowId: uuid("sent_by_flow_id"),
	sentByUserId: uuid("sent_by_user_id"),
	status: messageStatus().default('sent').notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("messages_conversation_id_created_at_idx").using("btree", table.conversationId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
	uniqueIndex("messages_platform_message_id_key").using("btree", table.platformMessageId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "messages_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.sentByUserId],
			foreignColumns: [users.id],
			name: "messages_sent_by_user_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.sentByRuleId],
			foreignColumns: [autoReplyRules.id],
			name: "messages_sent_by_rule_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.sentByFlowId],
			foreignColumns: [flows.id],
			name: "messages_sent_by_flow_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const flowSessions = pgTable("flow_sessions", {
	id: uuid().primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	flowId: uuid("flow_id").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	status: flowSessionStatus().default('active').notNull(),
	currentNodeId: text("current_node_id"),
	variables: jsonb().default({}).notNull(),
	waitingUntil: timestamp("waiting_until", { precision: 3, mode: 'string' }),
	waitingForInput: boolean("waiting_for_input").default(false).notNull(),
	humanTakeoverAt: timestamp("human_takeover_at", { precision: 3, mode: 'string' }),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("flow_sessions_contact_id_status_idx").using("btree", table.contactId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "flow_sessions_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_sessions_flow_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "flow_sessions_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const sequences = pgTable("sequences", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	description: text(),
	status: sequenceStatus().default('draft').notNull(),
	steps: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("sequences_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "sequences_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const sequenceEnrollments = pgTable("sequence_enrollments", {
	id: uuid().primaryKey().notNull(),
	sequenceId: uuid("sequence_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	currentStepIndex: integer("current_step_index").default(0).notNull(),
	status: sequenceEnrollmentStatus().default('active').notNull(),
	enrolledAt: timestamp("enrolled_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	nextStepAt: timestamp("next_step_at", { precision: 3, mode: 'string' }),
	completedAt: timestamp("completed_at", { precision: 3, mode: 'string' }),
}, (table) => [
	uniqueIndex("sequence_enrollments_sequence_id_contact_id_key").using("btree", table.sequenceId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.sequenceId],
			foreignColumns: [sequences.id],
			name: "sequence_enrollments_sequence_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "sequence_enrollments_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "sequence_enrollments_channel_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const broadcasts = pgTable("broadcasts", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	status: broadcastStatus().default('draft').notNull(),
	messageContent: jsonb("message_content").default({}).notNull(),
	segmentFilter: jsonb("segment_filter"),
	scheduledFor: timestamp("scheduled_for", { precision: 3, mode: 'string' }),
	totalRecipients: integer("total_recipients").default(0).notNull(),
	sent: integer().default(0).notNull(),
	delivered: integer().default(0).notNull(),
	failed: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "broadcasts_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const broadcastRecipients = pgTable("broadcast_recipients", {
	id: uuid().primaryKey().notNull(),
	broadcastId: uuid("broadcast_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	status: broadcastRecipientStatus().default('pending').notNull(),
	sentAt: timestamp("sent_at", { precision: 3, mode: 'string' }),
	errorMessage: text("error_message"),
}, (table) => [
	index("broadcast_recipients_broadcast_id_status_idx").using("btree", table.broadcastId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.broadcastId],
			foreignColumns: [broadcasts.id],
			name: "broadcast_recipients_broadcast_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "broadcast_recipients_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "broadcast_recipients_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const commentLogs = pgTable("comment_logs", {
	id: uuid().primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	postId: text("post_id"),
	platformCommentId: text("platform_comment_id").notNull(),
	authorId: text("author_id"),
	authorName: text("author_name"),
	commentText: text("comment_text").notNull(),
	matchedRuleId: uuid("matched_rule_id"),
	dmSent: boolean("dm_sent").default(false).notNull(),
	replySent: boolean("reply_sent").default(false).notNull(),
	error: text(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("comment_logs_channel_id_idx").using("btree", table.channelId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("comment_logs_channel_id_platform_comment_id_key").using("btree", table.channelId.asc().nullsLast().op("text_ops"), table.platformCommentId.asc().nullsLast().op("text_ops")),
	index("comment_logs_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "comment_logs_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const flowVersions = pgTable("flow_versions", {
	id: uuid().primaryKey().notNull(),
	flowId: uuid("flow_id").notNull(),
	version: integer().notNull(),
	nodes: jsonb().notNull(),
	edges: jsonb().notNull(),
	viewport: jsonb(),
	name: text().notNull(),
	publishedBy: uuid("published_by"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("flow_versions_flow_id_version_idx").using("btree", table.flowId.asc().nullsLast().op("int4_ops"), table.version.desc().nullsFirst().op("int4_ops")),
	uniqueIndex("flow_versions_flow_id_version_key").using("btree", table.flowId.asc().nullsLast().op("uuid_ops"), table.version.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_versions_flow_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const apiKeys = pgTable("api_keys", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	keyHash: text("key_hash").notNull(),
	keyPrefix: text("key_prefix").notNull(),
	lastUsedAt: timestamp("last_used_at", { precision: 3, mode: 'string' }),
	expiresAt: timestamp("expires_at", { precision: 3, mode: 'string' }),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	scopes: text().array().default(["RAY"]),
}, (table) => [
	uniqueIndex("api_keys_key_hash_key").using("btree", table.keyHash.asc().nullsLast().op("text_ops")),
	index("api_keys_workspace_id_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "api_keys_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const autoReplyRules = pgTable("auto_reply_rules", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	channelId: uuid("channel_id"),
	name: text().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	priority: integer().default(0).notNull(),
	triggerType: triggerType("trigger_type").notNull(),
	triggerConfig: jsonb("trigger_config").default({}).notNull(),
	responseType: responseType("response_type").default('text').notNull(),
	responseConfig: jsonb("response_config").default({}).notNull(),
	actions: jsonb().default([]).notNull(),
	cooldownSeconds: integer("cooldown_seconds").default(0).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
	maxSendsPerContact: integer("max_sends_per_contact"),
	requiresApproval: boolean("requires_approval").default(false).notNull(),
}, (table) => [
	index("auto_reply_rules_channel_id_trigger_type_is_active_idx").using("btree", table.channelId.asc().nullsLast().op("enum_ops"), table.triggerType.asc().nullsLast().op("bool_ops"), table.isActive.asc().nullsLast().op("enum_ops")),
	index("auto_reply_rules_workspace_id_is_active_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.isActive.asc().nullsLast().op("bool_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "auto_reply_rules_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "auto_reply_rules_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const outboundIdempotency = pgTable("outbound_idempotency", {
	key: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("outbound_idempotency_expires_at_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamp_ops")),
]);

export const pendingApprovals = pgTable("pending_approvals", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	ruleId: uuid("rule_id").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	recipientPlatformId: text("recipient_platform_id").notNull(),
	proposedContent: jsonb("proposed_content").notNull(),
	status: approvalStatus().default('pending').notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	resolvedAt: timestamp("resolved_at", { precision: 3, mode: 'string' }),
	resolvedBy: uuid("resolved_by"),
}, (table) => [
	index("pending_approvals_workspace_id_status_idx").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "pending_approvals_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.ruleId],
			foreignColumns: [autoReplyRules.id],
			name: "pending_approvals_rule_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "pending_approvals_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "pending_approvals_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "pending_approvals_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const revokedTokens = pgTable("revoked_tokens", {
	jti: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("revoked_tokens_expires_at_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamp_ops")),
]);

export const rateLimitCounters = pgTable("rate_limit_counters", {
	key: text().primaryKey().notNull(),
	count: integer().notNull(),
	windowStart: timestamp("window_start", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("rate_limit_counters_window_start_idx").using("btree", table.windowStart.asc().nullsLast().op("timestamp_ops")),
]);

export const contactTags = pgTable("contact_tags", {
	contactId: uuid("contact_id").notNull(),
	tagId: uuid("tag_id").notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_tags_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tags.id],
			name: "contact_tags_tag_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.contactId, table.tagId], name: "contact_tags_pkey"}),
]);

export const ruleCooldowns = pgTable("rule_cooldowns", {
	ruleId: uuid("rule_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("rule_cooldowns_expires_at_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamp_ops")),
	primaryKey({ columns: [table.ruleId, table.contactId], name: "rule_cooldowns_pkey"}),
]);

export const ruleSendCounts = pgTable("rule_send_counts", {
	ruleId: uuid("rule_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	count: integer().default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.ruleId, table.contactId], name: "rule_send_counts_pkey"}),
]);

export const workspaceMembers = pgTable("workspace_members", {
	workspaceId: uuid("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	role: workspaceMemberRole().default('owner').notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("workspace_members_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "workspace_members_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "workspace_members_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.workspaceId, table.userId], name: "workspace_members_pkey"}),
]);
