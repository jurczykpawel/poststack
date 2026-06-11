import { pgTable, timestamp, text, integer, uniqueIndex, index, foreignKey, uuid, boolean, jsonb, primaryKey, pgEnum, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const approvalStatus = pgEnum("approval_status", ['pending', 'approved', 'rejected'])
// `system` is reserved/forward-looking: actorFromAuth only ever emits user/api_key, and no
// cron/worker/maintenance path audits yet, so it's currently unreachable. Kept for when system
// actions (token-refresh / maintenance) start writing audit rows.
export const auditActorType = pgEnum("audit_actor_type", ['user', 'api_key', 'system'])
export const broadcastRecipientStatus = pgEnum("broadcast_recipient_status", ['pending', 'sent', 'delivered', 'failed'])
export const broadcastStatus = pgEnum("broadcast_status", ['draft', 'scheduled', 'sending', 'completed', 'cancelled'])
export const channelConnectionMode = pgEnum("channel_connection_mode", ['oauth', 'manual_token'])
export const channelStatus = pgEnum("channel_status", ['active', 'needs_reauth', 'paused', 'disabled'])
export const conversationStatus = pgEnum("conversation_status", ['open', 'closed', 'snoozed'])
export const flowSessionStatus = pgEnum("flow_session_status", ['active', 'completed', 'expired', 'cancelled'])
export const flowStatus = pgEnum("flow_status", ['draft', 'published', 'archived'])
export const messageDirection = pgEnum("message_direction", ['inbound', 'outbound'])
// `pending` + `delivered` are reserved/forward-looking: inbound rows default `sent` and there is no
// delivery-receipt path that would write `delivered`, so neither is reachable today (only referenced
// defensively in retention PRUNABLE_STATUSES). Kept for a future send-state / read-receipt path.
export const messageStatus = pgEnum("message_status", ['pending', 'sent', 'delivered', 'failed', 'held', 'expired'])
export const outboundDeliveryStatus = pgEnum("outbound_delivery_status", ['pending', 'sending', 'sent', 'failed', 'held', 'expired', 'unknown'])
// `tiktok`/`twitter`/`gmail`/`discord` are reserved enum values with NO provider in the registry —
// getProvider() throws for them and OAuth/connect only ever writes facebook/instagram/telegram. They
// are forward-looking placeholders, currently unreachable.
export const platform = pgEnum("platform", ['facebook', 'instagram', 'telegram', 'tiktok', 'twitter', 'gmail', 'discord'])
export type Platform = (typeof platform.enumValues)[number]
export const response_type = pgEnum("response_type", ['text', 'random_text', 'sequence', 'none', 'ai_rephrase', 'follow_gate'])
// `paused` is reserved/forward-looking: pausing happens at the channel/conversation level
// (`is_automation_paused`, `channel.status='paused'`) and the worker DEFERS a step via a delayed job
// rather than flipping the enrollment to `paused`, so nothing writes it. Kept for a future
// per-enrollment pause (confirms the hint).
export const sequenceEnrollmentStatus = pgEnum("sequence_enrollment_status", ['active', 'paused', 'completed', 'cancelled'])
export const sequenceStatus = pgEnum("sequence_status", ['draft', 'active', 'archived'])
export const trigger_type = pgEnum("trigger_type", ['keyword', 'comment_keyword', 'postback', 'welcome', 'default', 'story_reply', 'story_mention', 'reaction'])
// Lifecycle of a logged inbound webhook event. `received` is the non-terminal landing state (a
// handler job was enqueued); the rest are terminal. `unhandled` = no handler for this event type
// (logged for inspection, no job); `ignored` = recognized but intentionally not acted on (self-loop
// guard, echo with no matching delivery, non-private TG chat); `fired`/`no_match`/`paused` mirror the
// rule outcomes; `error` = the handler threw after exhausting retries.
export const webhookEventHandlingStatus = pgEnum("webhook_event_handling_status", ['received', 'fired', 'no_match', 'paused', 'ignored', 'unhandled', 'error'])
// Only `owner` for now: role-based authorization isn't enforced yet, and `admin`/`agent`
// would be misleading dead values. Re-add richer roles together with member invitations +
// `requireRole()` enforcement.
export const workspaceMemberRole = pgEnum("workspace_member_role", ['owner'])


export const conversations = pgTable("conversations", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	channel_id: uuid("channel_id").notNull(),
	contact_id: uuid("contact_id").notNull(),
	platform: platform().notNull(),
	platform_conversation_id: text("platform_conversation_id"),
	status: conversationStatus().default('open').notNull(),
	assigned_to: uuid("assigned_to"),
	last_message_at: timestamp("last_message_at", { precision: 3, mode: 'date' }),
	last_message_preview: text("last_message_preview"),
	unread_count: integer("unread_count").default(0).notNull(),
	is_automation_paused: boolean("is_automation_paused").default(false).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
	needs_manual_reply: boolean("needs_manual_reply").default(false).notNull(),
	last_inbound_at: timestamp("last_inbound_at", { precision: 3, mode: 'date' }),
}, (table) => [
	uniqueIndex("conversations_channel_id_contact_id_key").using("btree", table.channel_id.asc().nullsLast(), table.contact_id.asc().nullsLast()),
	index("conversations_workspace_id_last_message_at_idx").using("btree", table.workspace_id.asc().nullsLast(), table.last_message_at.desc().nullsFirst()),
	index("conversations_workspace_id_status_idx").using("btree", table.workspace_id.asc().nullsLast(), table.status.asc().nullsLast()),
	// Channel-filtered inbox list ordered by recency (GET /conversations?channel_id=…).
	index("conversations_ws_channel_last_message_at_idx").using("btree", table.workspace_id.asc().nullsLast(), table.channel_id.asc().nullsLast(), table.last_message_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "conversations_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "conversations_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "conversations_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.assigned_to],
			foreignColumns: [users.id],
			name: "conversations_assigned_to_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const channels = pgTable("channels", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	platform: platform().notNull(),
	platform_id: text("platform_id").notNull(),
	display_name: text("display_name"),
	username: text(),
	profile_picture: text("profile_picture"),
	token_encrypted: text("token_encrypted").notNull(),
	webhook_secret: text("webhook_secret").notNull(),
	// Reserved/forward-looking: never written or read today (the comment poller doesn't persist a
	// cursor). Kept for a future incremental comment-poll that resumes from the last seen comment
	// instead of re-scanning (parked rather than dropped to avoid a baseline-regen migration).
	last_comment_cursor: text("last_comment_cursor"),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
	last_error: text("last_error"),
	last_health_at: timestamp("last_health_at", { precision: 3, mode: 'date' }),
	status: channelStatus().default('active').notNull(),
	connection_mode: channelConnectionMode("connection_mode").default('oauth').notNull(),
}, (table) => [
	index("channels_status_idx").using("btree", table.status.asc().nullsLast()),
	index("channels_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast()),
	// Unique per (workspace, platform, platform_id) — a superset of the old
	// (workspace_id, platform_id) key, so adding it never fails on existing data.
	// Adding `platform` stops a numeric id colliding across platforms (e.g. a FB
	// page vs a Telegram bot). "One account, one workspace" is enforced in the app
	// layer (upsertChannels rejects connecting an account owned elsewhere).
	uniqueIndex("channels_workspace_id_platform_platform_id_key").using("btree", table.workspace_id.asc().nullsLast(), table.platform.asc().nullsLast(), table.platform_id.asc().nullsLast()),
	// At most one NON-disabled channel per (platform, platform_id) across the whole
	// instance. Incoming webhook events carry only the account id, so routing resolves
	// the channel by (platform, platform_id) filtered to non-disabled — this partial
	// index makes that resolution unambiguous (one live owner per account). Disabled
	// rows are exempt, so an account released by one workspace can be re-used, and the
	// migration that adds this index stays safe (it disables any pre-existing duplicate
	// first, then the index can be created).
	uniqueIndex("channels_active_platform_platform_id_key").using("btree", table.platform.asc().nullsLast(), table.platform_id.asc().nullsLast()).where(sql`status <> 'disabled'`),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "channels_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const workspaces = pgTable("workspaces", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	name: text().notNull(),
	slug: text().notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
	message_retention_days: integer("message_retention_days"),
}, (table) => [
	uniqueIndex("workspaces_slug_key").using("btree", table.slug.asc().nullsLast()),
]);

export const users = pgTable("users", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	email: text().notNull(),
	password_hash: text("password_hash"),
	name: text(),
	avatar_url: text("avatar_url"),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	uniqueIndex("users_email_key").using("btree", table.email.asc().nullsLast()),
]);

export const contacts = pgTable("contacts", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	display_name: text("display_name"),
	email: text(),
	avatar_url: text("avatar_url"),
	is_subscribed: boolean("is_subscribed").default(true).notNull(),
	last_interaction_at: timestamp("last_interaction_at", { precision: 3, mode: 'date' }),
	metadata: jsonb().default({}).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	index("contacts_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast()),
	index("contacts_workspace_id_last_interaction_at_idx").using("btree", table.workspace_id.asc().nullsLast(), table.last_interaction_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "contacts_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const contactChannels = pgTable("contact_channels", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	contact_id: uuid("contact_id").notNull(),
	channel_id: uuid("channel_id").notNull(),
	platform_sender_id: text("platform_sender_id").notNull(),
	platform_username: text("platform_username"),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("contact_channels_channel_id_platform_sender_id_key").using("btree", table.channel_id.asc().nullsLast(), table.platform_sender_id.asc().nullsLast()),
	index("contact_channels_contact_id_idx").using("btree", table.contact_id.asc().nullsLast()),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "contact_channels_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "contact_channels_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const tags = pgTable("tags", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	name: text().notNull(),
	color: text().default('#6366f1').notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("tags_workspace_id_name_key").using("btree", table.workspace_id.asc().nullsLast(), table.name.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "tags_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const auditLogs = pgTable("audit_logs", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	actor_type: auditActorType("actor_type").notNull(),
	actor_id: text("actor_id"),
	action: text().notNull(),
	target_type: text("target_type"),
	target_id: text("target_id"),
	metadata: jsonb(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("audit_logs_workspace_id_created_at_idx").using("btree", table.workspace_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "audit_logs_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const flows = pgTable("flows", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	name: text().notNull(),
	description: text(),
	status: flowStatus().default('draft').notNull(),
	nodes: jsonb().default([]).notNull(),
	edges: jsonb().default([]).notNull(),
	viewport: jsonb(),
	version: integer().default(1).notNull(),
	published_at: timestamp("published_at", { precision: 3, mode: 'date' }),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	index("flows_workspace_id_status_idx").using("btree", table.workspace_id.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "flows_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const flowTriggers = pgTable("flow_triggers", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	flow_id: uuid("flow_id").notNull(),
	channel_id: uuid("channel_id"),
	type: trigger_type().notNull(),
	config: jsonb().default({}).notNull(),
	priority: integer().default(0).notNull(),
	is_active: boolean("is_active").default(true).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("flow_triggers_channel_id_type_is_active_idx").using("btree", table.channel_id.asc().nullsLast(), table.type.asc().nullsLast(), table.is_active.asc().nullsLast()),
	foreignKey({
			columns: [table.flow_id],
			foreignColumns: [flows.id],
			name: "flow_triggers_flow_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "flow_triggers_channel_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const messages = pgTable("messages", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	conversation_id: uuid("conversation_id").notNull(),
	direction: messageDirection().notNull(),
	text: text(),
	attachments: jsonb(),
	quick_reply_payload: text("quick_reply_payload"),
	postback_payload: text("postback_payload"),
	platform_message_id: text("platform_message_id"),
	sent_by_rule_id: uuid("sent_by_rule_id"),
	// Reserved for a future flow engine — NEVER written today (workers stamp sent_by_rule_id /
	// sent_by_user_id). Kept as the FK target for when flows ship; currently always NULL.
	sent_by_flow_id: uuid("sent_by_flow_id"),
	sent_by_user_id: uuid("sent_by_user_id"),
	status: messageStatus().default('sent').notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("messages_conversation_id_created_at_idx").using("btree", table.conversation_id.asc().nullsLast(), table.created_at.asc().nullsLast()),
	uniqueIndex("messages_conversation_id_platform_message_id_key").using("btree", table.conversation_id.asc().nullsLast(), table.platform_message_id.asc().nullsLast()),
	foreignKey({
			columns: [table.conversation_id],
			foreignColumns: [conversations.id],
			name: "messages_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.sent_by_user_id],
			foreignColumns: [users.id],
			name: "messages_sent_by_user_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.sent_by_rule_id],
			foreignColumns: [autoReplyRules.id],
			name: "messages_sent_by_rule_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.sent_by_flow_id],
			foreignColumns: [flows.id],
			name: "messages_sent_by_flow_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const flowSessions = pgTable("flow_sessions", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	contact_id: uuid("contact_id").notNull(),
	flow_id: uuid("flow_id").notNull(),
	conversation_id: uuid("conversation_id").notNull(),
	status: flowSessionStatus().default('active').notNull(),
	current_node_id: text("current_node_id"),
	variables: jsonb().default({}).notNull(),
	waiting_until: timestamp("waiting_until", { precision: 3, mode: 'date' }),
	waiting_for_input: boolean("waiting_for_input").default(false).notNull(),
	human_takeover_at: timestamp("human_takeover_at", { precision: 3, mode: 'date' }),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	index("flow_sessions_contact_id_status_idx").using("btree", table.contact_id.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "flow_sessions_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.flow_id],
			foreignColumns: [flows.id],
			name: "flow_sessions_flow_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.conversation_id],
			foreignColumns: [conversations.id],
			name: "flow_sessions_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const sequences = pgTable("sequences", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	name: text().notNull(),
	description: text(),
	status: sequenceStatus().default('draft').notNull(),
	steps: jsonb().default([]).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	index("sequences_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "sequences_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const sequenceEnrollments = pgTable("sequence_enrollments", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	sequence_id: uuid("sequence_id").notNull(),
	contact_id: uuid("contact_id").notNull(),
	channel_id: uuid("channel_id").notNull(),
	current_step_index: integer("current_step_index").default(0).notNull(),
	// Immutable snapshot of the sequence's steps taken at enrollment time. The worker drives
	// the enrollment from THIS, so editing/reordering the live sequence definition never makes
	// an in-flight enrollment skip a step or get a different message.
	steps_snapshot: jsonb("steps_snapshot").default([]).notNull(),
	status: sequenceEnrollmentStatus().default('active').notNull(),
	enrolled_at: timestamp("enrolled_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	next_step_at: timestamp("next_step_at", { precision: 3, mode: 'date' }),
	completed_at: timestamp("completed_at", { precision: 3, mode: 'date' }),
}, (table) => [
	uniqueIndex("sequence_enrollments_sequence_id_contact_id_key").using("btree", table.sequence_id.asc().nullsLast(), table.contact_id.asc().nullsLast()),
	// Supports the retention husk-prune NOT EXISTS guard, which looks up an active
	// enrollment by (contact_id, channel_id). Partial on active rows — the only ones the guard
	// (and the worker) care about — so it stays tiny.
	index("sequence_enrollments_active_contact_channel_idx").using("btree", table.contact_id.asc().nullsLast(), table.channel_id.asc().nullsLast()).where(sql`status = 'active'`),
	foreignKey({
			columns: [table.sequence_id],
			foreignColumns: [sequences.id],
			name: "sequence_enrollments_sequence_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "sequence_enrollments_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "sequence_enrollments_channel_id_fkey"
			// Deliberately RESTRICT (reviewed, NOT changed to cascade): this is what makes the
			// channel-disconnect handler return a clean 409 instead of silently cascade-deleting an
			// in-flight enrollment — there is no separate app-level guard, the FK IS the guard. A future
			// workspace-delete / GDPR-erasure handler must therefore delete sequences/enrollments BEFORE
			// channels (or add its own app-level guard) rather than relying on a single cascade statement.
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const broadcasts = pgTable("broadcasts", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	name: text().notNull(),
	status: broadcastStatus().default('draft').notNull(),
	message_content: jsonb("message_content").default({}).notNull(),
	segment_filter: jsonb("segment_filter"),
	scheduled_for: timestamp("scheduled_for", { precision: 3, mode: 'date' }),
	total_recipients: integer("total_recipients").default(0).notNull(),
	sent: integer().default(0).notNull(),
	delivered: integer().default(0).notNull(),
	failed: integer().default(0).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "broadcasts_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const broadcastRecipients = pgTable("broadcast_recipients", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	broadcast_id: uuid("broadcast_id").notNull(),
	contact_id: uuid("contact_id").notNull(),
	channel_id: uuid("channel_id").notNull(),
	status: broadcastRecipientStatus().default('pending').notNull(),
	sent_at: timestamp("sent_at", { precision: 3, mode: 'date' }),
	error_message: text("error_message"),
}, (table) => [
	index("broadcast_recipients_broadcast_id_status_idx").using("btree", table.broadcast_id.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.broadcast_id],
			foreignColumns: [broadcasts.id],
			name: "broadcast_recipients_broadcast_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "broadcast_recipients_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "broadcast_recipients_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const commentLogs = pgTable("comment_logs", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	channel_id: uuid("channel_id").notNull(),
	workspace_id: uuid("workspace_id").notNull(),
	post_id: text("post_id"),
	platform_comment_id: text("platform_comment_id").notNull(),
	author_id: text("author_id"),
	author_name: text("author_name"),
	comment_text: text("comment_text").notNull(),
	matched_rule_id: uuid("matched_rule_id"),
	dm_sent: boolean("dm_sent").default(false).notNull(),
	reply_sent: boolean("reply_sent").default(false).notNull(),
	error: text(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("comment_logs_channel_id_idx").using("btree", table.channel_id.asc().nullsLast()),
	uniqueIndex("comment_logs_channel_id_platform_comment_id_key").using("btree", table.channel_id.asc().nullsLast(), table.platform_comment_id.asc().nullsLast()),
	index("comment_logs_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast()),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "comment_logs_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const flowVersions = pgTable("flow_versions", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	flow_id: uuid("flow_id").notNull(),
	version: integer().notNull(),
	nodes: jsonb().notNull(),
	edges: jsonb().notNull(),
	viewport: jsonb(),
	name: text().notNull(),
	published_by: uuid("published_by"),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("flow_versions_flow_id_version_idx").using("btree", table.flow_id.asc().nullsLast(), table.version.desc().nullsFirst()),
	uniqueIndex("flow_versions_flow_id_version_key").using("btree", table.flow_id.asc().nullsLast(), table.version.asc().nullsLast()),
	foreignKey({
			columns: [table.flow_id],
			foreignColumns: [flows.id],
			name: "flow_versions_flow_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const apiKeys = pgTable("api_keys", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	name: text().notNull(),
	key_hash: text("key_hash").notNull(),
	key_prefix: text("key_prefix").notNull(),
	last_used_at: timestamp("last_used_at", { precision: 3, mode: 'date' }),
	expires_at: timestamp("expires_at", { precision: 3, mode: 'date' }),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	scopes: text().array().default([]),
}, (table) => [
	uniqueIndex("api_keys_key_hash_key").using("btree", table.key_hash.asc().nullsLast()),
	index("api_keys_workspace_id_idx").using("btree", table.workspace_id.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "api_keys_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const autoReplyRules = pgTable("auto_reply_rules", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	channel_id: uuid("channel_id"),
	name: text().notNull(),
	is_active: boolean("is_active").default(true).notNull(),
	priority: integer().default(0).notNull(),
	trigger_type: trigger_type("trigger_type").notNull(),
	trigger_config: jsonb("trigger_config").default({}).notNull(),
	response_type: response_type("response_type").default('text').notNull(),
	response_config: jsonb("response_config").default({}).notNull(),
	// Reserved scaffold for a future side-effect/action engine. The executor fetches it into
	// RuleCandidate.actions but NOTHING reads it, and PATCH/POST don't accept it — so it's always
	// the default []. Kept as a placeholder until an action engine exists.
	actions: jsonb().default([]).notNull(),
	cooldown_seconds: integer("cooldown_seconds").default(0).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
	max_sends_per_contact: integer("max_sends_per_contact"),
	requires_approval: boolean("requires_approval").default(false).notNull(),
}, (table) => [
	index("auto_reply_rules_channel_id_trigger_type_is_active_idx").using("btree", table.channel_id.asc().nullsLast(), table.trigger_type.asc().nullsLast(), table.is_active.asc().nullsLast()),
	index("auto_reply_rules_workspace_id_is_active_idx").using("btree", table.workspace_id.asc().nullsLast(), table.is_active.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "auto_reply_rules_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "auto_reply_rules_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

// Durable ledger for every outbound send. One row per logical send, keyed by a
// deterministic `delivery_key`, with an explicit state machine
// (pending→sending→sent / failed / held / expired / unknown). The provider call is
// sandwiched between a committed `sending` claim and an atomic `sent`+local-persist,
// so a crash mid-send leaves a recoverable `sending`→`unknown` record rather than a
// silent duplicate or lost local state. The full typed `payload` + `task_name`
// let a drain re-dispatch the exact original operation when a parked channel recovers.
export const outboundDeliveries = pgTable("outbound_deliveries", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	delivery_key: text("delivery_key").notNull(),
	workspace_id: uuid("workspace_id").notNull(),
	channel_id: uuid("channel_id").notNull(),
	// The contact this delivery addresses, when known (DM / follow-gate). Public comment
	// replies have none. Carries the FK that makes a contact erasure cascade here, so the
	// payload's PSID + message text can't survive the contact.
	contact_id: uuid("contact_id"),
	task_name: text("task_name").notNull(),
	status: outboundDeliveryStatus().default('pending').notNull(),
	payload: jsonb().notNull(),
	platform_message_id: text("platform_message_id"),
	// Set when Meta echoes our own sent message back (message.is_echo) and the echoed mid matches
	// this row's platform_message_id — a second, platform-confirmed signal that the reply actually
	// left Meta, beyond our own status=sent.
	confirmed_by_echo_at: timestamp("confirmed_by_echo_at", { precision: 3, mode: 'date' }),
	last_error: text("last_error"),
	attempts: integer().default(0).notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).defaultNow().notNull(),
	// $onUpdate keeps this fresh on every update without each call site having to pass it — the
	// only updated_at column that lacked it, so a future update path can't silently stale it.
	updated_at: timestamp("updated_at", { precision: 3, mode: 'date' }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	uniqueIndex("outbound_deliveries_delivery_key_key").using("btree", table.delivery_key.asc().nullsLast()),
	index("outbound_deliveries_channel_id_status_idx").using("btree", table.channel_id.asc().nullsLast(), table.status.asc().nullsLast()),
	// Maintenance prunes scan by (status, updated_at) on the busiest table.
	index("outbound_deliveries_status_updated_at_idx").using("btree", table.status.asc().nullsLast(), table.updated_at.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "outbound_deliveries_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "outbound_deliveries_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "outbound_deliveries_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

// Durable log of EVERY distinct inbound platform event + its handling outcome. One row per
// distinct event, written at receipt regardless of whether we can handle it, so nothing is ever
// silently dropped. Also folds in the old per-event dedup: `event_key` is unique, the edge logs
// with onConflictDoNothing (a redelivery is a no-op), and the worker does a CAS
// received→terminal inside its fire transaction — preserving at-least-once / at-most-once-fire.
export const webhookEvents = pgTable("webhook_events", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	// Discriminates a distinct action (e.g. `msg-<mid>`, `cmt-<commentId>-<verb>`,
	// `postback-<sender>-<ts>-<hash>`, `reaction-<sender>-<mid>-<ts>`, `echo-<mid>`, `tg-<identity>`).
	// The verb/action is part of the key so add/edit/delete of the same object are separate rows.
	event_key: text("event_key").notNull(),
	// Resolved page→channel (null when the page is unknown to us). SET NULL so erasing/deleting a
	// channel keeps the historical log row.
	channel_id: uuid("channel_id"),
	platform: platform(),
	object: text(),
	event_type: text("event_type").notNull(),
	field: text(),
	sender_id: text("sender_id"),
	recipient_id: text("recipient_id"),
	platform_message_id: text("platform_message_id"),
	is_echo: boolean("is_echo").default(false).notNull(),
	raw: jsonb().notNull(),
	handling_status: webhookEventHandlingStatus("handling_status").default('received').notNull(),
	handled_at: timestamp("handled_at", { precision: 3, mode: 'date' }),
	error_detail: text("error_detail"),
	contact_id: uuid("contact_id"),
	conversation_id: uuid("conversation_id"),
	message_id: uuid("message_id"),
	comment_log_id: uuid("comment_log_id"),
	outbound_delivery_id: uuid("outbound_delivery_id"),
	received_at: timestamp("received_at", { precision: 3, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("webhook_events_event_key_key").using("btree", table.event_key.asc().nullsLast()),
	index("webhook_events_channel_id_received_at_idx").using("btree", table.channel_id.asc().nullsLast(), table.received_at.desc().nullsFirst()),
	index("webhook_events_event_type_idx").using("btree", table.event_type.asc().nullsLast()),
	index("webhook_events_platform_message_id_idx").using("btree", table.platform_message_id.asc().nullsLast()),
	index("webhook_events_handling_status_idx").using("btree", table.handling_status.asc().nullsLast()),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "webhook_events_channel_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "webhook_events_contact_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.conversation_id],
			foreignColumns: [conversations.id],
			name: "webhook_events_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.message_id],
			foreignColumns: [messages.id],
			name: "webhook_events_message_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.comment_log_id],
			foreignColumns: [commentLogs.id],
			name: "webhook_events_comment_log_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.outbound_delivery_id],
			foreignColumns: [outboundDeliveries.id],
			name: "webhook_events_outbound_delivery_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const pendingApprovals = pgTable("pending_approvals", {
	id: uuid().primaryKey().notNull().defaultRandom(),
	workspace_id: uuid("workspace_id").notNull(),
	rule_id: uuid("rule_id").notNull(),
	conversation_id: uuid("conversation_id").notNull(),
	contact_id: uuid("contact_id").notNull(),
	channel_id: uuid("channel_id").notNull(),
	recipient_platform_id: text("recipient_platform_id").notNull(),
	proposed_content: jsonb("proposed_content").notNull(),
	status: approvalStatus().default('pending').notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	resolved_at: timestamp("resolved_at", { precision: 3, mode: 'date' }),
	resolved_by: uuid("resolved_by"),
}, (table) => [
	index("pending_approvals_workspace_id_status_idx").using("btree", table.workspace_id.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "pending_approvals_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.rule_id],
			foreignColumns: [autoReplyRules.id],
			name: "pending_approvals_rule_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.conversation_id],
			foreignColumns: [conversations.id],
			name: "pending_approvals_conversation_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "pending_approvals_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.channel_id],
			foreignColumns: [channels.id],
			name: "pending_approvals_channel_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const revokedTokens = pgTable("revoked_tokens", {
	jti: text().primaryKey().notNull(),
	expires_at: timestamp("expires_at", { precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	index("revoked_tokens_expires_at_idx").using("btree", table.expires_at.asc().nullsLast()),
]);

export const rateLimitCounters = pgTable("rate_limit_counters", {
	key: text().primaryKey().notNull(),
	count: integer().notNull(),
	window_start: timestamp("window_start", { precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	index("rate_limit_counters_window_start_idx").using("btree", table.window_start.asc().nullsLast()),
]);

export const contactTags = pgTable("contact_tags", {
	contact_id: uuid("contact_id").notNull(),
	tag_id: uuid("tag_id").notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "contact_tags_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.tag_id],
			foreignColumns: [tags.id],
			name: "contact_tags_tag_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.contact_id, table.tag_id], name: "contact_tags_pkey"}),
	// Reverse lookup: count/find contacts by tag (the PK is (contact_id, tag_id), useless for tag_id).
	index("contact_tags_tag_id_idx").using("btree", table.tag_id.asc().nullsLast()),
]);

export const ruleCooldowns = pgTable("rule_cooldowns", {
	rule_id: uuid("rule_id").notNull(),
	contact_id: uuid("contact_id").notNull(),
	expires_at: timestamp("expires_at", { precision: 3, mode: 'date' }).notNull(),
}, (table) => [
	index("rule_cooldowns_expires_at_idx").using("btree", table.expires_at.asc().nullsLast()),
	primaryKey({ columns: [table.rule_id, table.contact_id], name: "rule_cooldowns_pkey"}),
	foreignKey({
			columns: [table.rule_id],
			foreignColumns: [autoReplyRules.id],
			name: "rule_cooldowns_rule_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "rule_cooldowns_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const ruleSendCounts = pgTable("rule_send_counts", {
	rule_id: uuid("rule_id").notNull(),
	contact_id: uuid("contact_id").notNull(),
	count: integer().default(0).notNull(),
}, (table) => [
	primaryKey({ columns: [table.rule_id, table.contact_id], name: "rule_send_counts_pkey"}),
	// Lifetime counters aren't pruned by TTL — without these FKs an erased contact's (or a
	// deleted rule's) rows would linger forever. Cascade keeps erasure complete.
	foreignKey({
			columns: [table.rule_id],
			foreignColumns: [autoReplyRules.id],
			name: "rule_send_counts_rule_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.contact_id],
			foreignColumns: [contacts.id],
			name: "rule_send_counts_contact_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const workspaceMembers = pgTable("workspace_members", {
	workspace_id: uuid("workspace_id").notNull(),
	user_id: uuid("user_id").notNull(),
	role: workspaceMemberRole().default('owner').notNull(),
	created_at: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("workspace_members_user_id_idx").using("btree", table.user_id.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "workspace_members_workspace_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "workspace_members_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	primaryKey({ columns: [table.workspace_id, table.user_id], name: "workspace_members_pkey"}),
]);

export const instanceLicenseStatus = pgEnum("instance_license_status", ['none', 'active', 'expired', 'invalid'])

// Instance-global license (NOT workspace-scoped). ReplyStack is sold per self-hosted
// instance; one valid Sellf license unlocks PRO features for the whole instance, so this
// is a deliberate exception to the "every table has workspace_id + FK" rule. Enforced as a
// singleton via the `id = 'singleton'` check constraint.
export const instanceLicense = pgTable("instance_license", {
	id: text("id").primaryKey().default('singleton'),
	token: text("token"), // encrypted at rest (AES-256-GCM, src/lib/crypto.ts); null = no license
	tier: text("tier"),
	status: instanceLicenseStatus().default('none').notNull(),
	expires_at: timestamp("expires_at", { precision: 3, mode: 'date' }),
	verified_at: timestamp("verified_at", { precision: 3, mode: 'date' }),
	jwks_snapshot: jsonb("jwks_snapshot"), // last-known-good keys for cold-boot during a JWKS outage
	last_error: text("last_error"),
	updated_at: timestamp("updated_at", { precision: 3, mode: "date" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
	check("instance_license_singleton", sql`${table.id} = 'singleton'`),
]);
