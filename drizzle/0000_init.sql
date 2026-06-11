CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'api_key', 'system');--> statement-breakpoint
CREATE TYPE "public"."broadcast_recipient_status" AS ENUM('pending', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'scheduled', 'sending', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel_connection_mode" AS ENUM('oauth', 'manual_token');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'needs_reauth', 'paused', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'closed', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."flow_session_status" AS ENUM('active', 'completed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."flow_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'sent', 'delivered', 'failed', 'held', 'expired');--> statement-breakpoint
CREATE TYPE "public"."outbound_delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'held', 'expired', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('facebook', 'instagram', 'telegram', 'tiktok', 'twitter', 'gmail', 'discord');--> statement-breakpoint
CREATE TYPE "public"."response_type" AS ENUM('text', 'random_text', 'sequence', 'none', 'ai_rephrase', 'follow_gate');--> statement-breakpoint
CREATE TYPE "public"."sequence_enrollment_status" AS ENUM('active', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sequence_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('keyword', 'comment_keyword', 'postback', 'welcome', 'default', 'story_reply', 'story_mention', 'reaction');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_handling_status" AS ENUM('received', 'fired', 'no_match', 'paused', 'ignored', 'unhandled', 'error');--> statement-breakpoint
CREATE TYPE "public"."workspace_member_role" AS ENUM('owner');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"last_used_at" timestamp (3),
	"expires_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"scopes" text[] DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_reply_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"trigger_type" "trigger_type" NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_type" "response_type" DEFAULT 'text' NOT NULL,
	"response_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cooldown_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	"max_sends_per_contact" integer,
	"requires_approval" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" "broadcast_recipient_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp (3),
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"message_content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"segment_filter" jsonb,
	"scheduled_for" timestamp (3),
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_id" text NOT NULL,
	"display_name" text,
	"username" text,
	"profile_picture" text,
	"token_encrypted" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"last_comment_cursor" text,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	"last_error" text,
	"last_health_at" timestamp (3),
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"connection_mode" "channel_connection_mode" DEFAULT 'oauth' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" text,
	"platform_comment_id" text NOT NULL,
	"author_id" text,
	"author_name" text,
	"comment_text" text NOT NULL,
	"matched_rule_id" uuid,
	"dm_sent" boolean DEFAULT false NOT NULL,
	"reply_sent" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform_sender_id" text NOT NULL,
	"platform_username" text,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "contact_tags_pkey" PRIMARY KEY("contact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text,
	"email" text,
	"avatar_url" text,
	"is_subscribed" boolean DEFAULT true NOT NULL,
	"last_interaction_at" timestamp (3),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_conversation_id" text,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"last_message_at" timestamp (3),
	"last_message_preview" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"is_automation_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	"needs_manual_reply" boolean DEFAULT false NOT NULL,
	"last_inbound_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "flow_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" "flow_session_status" DEFAULT 'active' NOT NULL,
	"current_node_id" text,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"waiting_until" timestamp (3),
	"waiting_for_input" boolean DEFAULT false NOT NULL,
	"human_takeover_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"channel_id" uuid,
	"type" "trigger_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"nodes" jsonb NOT NULL,
	"edges" jsonb NOT NULL,
	"viewport" jsonb,
	"name" text NOT NULL,
	"published_by" uuid,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "flow_status" DEFAULT 'draft' NOT NULL,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"viewport" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"text" text,
	"attachments" jsonb,
	"quick_reply_payload" text,
	"postback_payload" text,
	"platform_message_id" text,
	"sent_by_rule_id" uuid,
	"sent_by_flow_id" uuid,
	"sent_by_user_id" uuid,
	"status" "message_status" DEFAULT 'sent' NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_key" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"contact_id" uuid,
	"task_name" text NOT NULL,
	"status" "outbound_delivery_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"platform_message_id" text,
	"confirmed_by_echo_at" timestamp (3),
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"recipient_platform_id" text NOT NULL,
	"proposed_content" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"resolved_at" timestamp (3),
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revoked_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_cooldowns" (
	"rule_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"expires_at" timestamp (3) NOT NULL,
	CONSTRAINT "rule_cooldowns_pkey" PRIMARY KEY("rule_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "rule_send_counts" (
	"rule_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rule_send_counts_pkey" PRIMARY KEY("rule_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"steps_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "sequence_enrollment_status" DEFAULT 'active' NOT NULL,
	"enrolled_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"next_step_at" timestamp (3),
	"completed_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "sequence_status" DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"channel_id" uuid,
	"platform" "platform",
	"object" text,
	"event_type" text NOT NULL,
	"field" text,
	"sender_id" text,
	"recipient_id" text,
	"platform_message_id" text,
	"is_echo" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"handling_status" "webhook_event_handling_status" DEFAULT 'received' NOT NULL,
	"handled_at" timestamp (3),
	"error_detail" text,
	"contact_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"comment_log_id" uuid,
	"outbound_delivery_id" uuid,
	"received_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_member_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	"message_retention_days" integer
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auto_reply_rules" ADD CONSTRAINT "auto_reply_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auto_reply_rules" ADD CONSTRAINT "auto_reply_rules_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flow_triggers" ADD CONSTRAINT "flow_triggers_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flow_triggers" ADD CONSTRAINT "flow_triggers_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_rule_id_fkey" FOREIGN KEY ("sent_by_rule_id") REFERENCES "public"."auto_reply_rules"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_flow_id_fkey" FOREIGN KEY ("sent_by_flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."auto_reply_rules"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rule_cooldowns" ADD CONSTRAINT "rule_cooldowns_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."auto_reply_rules"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rule_cooldowns" ADD CONSTRAINT "rule_cooldowns_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rule_send_counts" ADD CONSTRAINT "rule_send_counts_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."auto_reply_rules"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rule_send_counts" ADD CONSTRAINT "rule_send_counts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_comment_log_id_fkey" FOREIGN KEY ("comment_log_id") REFERENCES "public"."comment_logs"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_outbound_delivery_id_fkey" FOREIGN KEY ("outbound_delivery_id") REFERENCES "public"."outbound_deliveries"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "audit_logs_workspace_id_created_at_idx" ON "audit_logs" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "auto_reply_rules_channel_id_trigger_type_is_active_idx" ON "auto_reply_rules" USING btree ("channel_id","trigger_type","is_active");--> statement-breakpoint
CREATE INDEX "auto_reply_rules_workspace_id_is_active_idx" ON "auto_reply_rules" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_broadcast_id_status_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE INDEX "channels_status_idx" ON "channels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "channels_workspace_id_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_workspace_id_platform_platform_id_key" ON "channels" USING btree ("workspace_id","platform","platform_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_active_platform_platform_id_key" ON "channels" USING btree ("platform","platform_id") WHERE status <> 'disabled';--> statement-breakpoint
CREATE INDEX "comment_logs_channel_id_idx" ON "comment_logs" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_logs_channel_id_platform_comment_id_key" ON "comment_logs" USING btree ("channel_id","platform_comment_id");--> statement-breakpoint
CREATE INDEX "comment_logs_workspace_id_idx" ON "comment_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_channels_channel_id_platform_sender_id_key" ON "contact_channels" USING btree ("channel_id","platform_sender_id");--> statement-breakpoint
CREATE INDEX "contact_channels_contact_id_idx" ON "contact_channels" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_tags_tag_id_idx" ON "contact_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_id_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_id_last_interaction_at_idx" ON "contacts" USING btree ("workspace_id","last_interaction_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_id_contact_id_key" ON "conversations" USING btree ("channel_id","contact_id");--> statement-breakpoint
CREATE INDEX "conversations_workspace_id_last_message_at_idx" ON "conversations" USING btree ("workspace_id","last_message_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "conversations_workspace_id_status_idx" ON "conversations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "conversations_ws_channel_last_message_at_idx" ON "conversations" USING btree ("workspace_id","channel_id","last_message_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "flow_sessions_contact_id_status_idx" ON "flow_sessions" USING btree ("contact_id","status");--> statement-breakpoint
CREATE INDEX "flow_triggers_channel_id_type_is_active_idx" ON "flow_triggers" USING btree ("channel_id","type","is_active");--> statement-breakpoint
CREATE INDEX "flow_versions_flow_id_version_idx" ON "flow_versions" USING btree ("flow_id","version" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "flow_versions_flow_id_version_key" ON "flow_versions" USING btree ("flow_id","version");--> statement-breakpoint
CREATE INDEX "flows_workspace_id_status_idx" ON "flows" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_id_platform_message_id_key" ON "messages" USING btree ("conversation_id","platform_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_deliveries_delivery_key_key" ON "outbound_deliveries" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_channel_id_status_idx" ON "outbound_deliveries" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_status_updated_at_idx" ON "outbound_deliveries" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "pending_approvals_workspace_id_status_idx" ON "pending_approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_start_idx" ON "rate_limit_counters" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "revoked_tokens_expires_at_idx" ON "revoked_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rule_cooldowns_expires_at_idx" ON "rule_cooldowns" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_enrollments_sequence_id_contact_id_key" ON "sequence_enrollments" USING btree ("sequence_id","contact_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_active_contact_channel_idx" ON "sequence_enrollments" USING btree ("contact_id","channel_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "sequences_workspace_id_idx" ON "sequences" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_workspace_id_name_key" ON "tags" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_event_key_key" ON "webhook_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "webhook_events_channel_id_received_at_idx" ON "webhook_events" USING btree ("channel_id","received_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "webhook_events_platform_message_id_idx" ON "webhook_events" USING btree ("platform_message_id");--> statement-breakpoint
CREATE INDEX "webhook_events_handling_status_idx" ON "webhook_events" USING btree ("handling_status");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces" USING btree ("slug");