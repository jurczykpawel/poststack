/**
 * OpenAPI 3.1 specification for ReplyStack API v1.
 *
 * Add new endpoints here as they are implemented.
 * Served at GET /api/v1 (JSON) and GET /api/docs (Scalar UI).
 */

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "ReplyStack API",
    version: "1.0.0",
    description:
      "Self-hosted social media inbox automation API. " +
      "Authenticate with an API key: `Authorization: Bearer rs_live_...`\n\n" +
      "Generate API keys in Settings > API Keys.",
    license: { name: "AGPL-3.0", url: "https://www.gnu.org/licenses/agpl-3.0" },
    contact: { url: "https://github.com/jurczykpawel/replystack" },
  },
  servers: [{ url: "/api/v1", description: "Current instance" }],
  security: [{ BearerAuth: [] }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key (rs_live_...)",
        description:
          "API key generated in Settings > API Keys. " +
          "Format: `Authorization: Bearer rs_live_<key>`",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["data", "error"],
        properties: {
          data: { type: "null" },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string", example: "NOT_FOUND" },
              message: { type: "string", example: "Resource not found" },
              details: {},
            },
          },
        },
      },
      Pagination: {
        type: "object",
        properties: {
          page: { type: "integer", example: 1 },
          limit: { type: "integer", example: 20 },
          total: { type: "integer", example: 142 },
          has_more: { type: "boolean", example: true },
        },
      },
      Channel: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          platform: { type: "string", enum: ["facebook", "instagram", "telegram"] },
          display_name: { type: "string", example: "My Business Page" },
          username: { type: "string", nullable: true },
          profile_picture: { type: "string", format: "uri", nullable: true },
          status: { type: "string", enum: ["active", "needs_reauth", "paused", "disabled"] },
          connection_mode: { type: "string", enum: ["oauth", "manual_token"], description: "manual_token = pasted long-lived/System User token, not auto-refreshed" },
          last_error: { type: "string", nullable: true },
          last_health_at: { type: "string", format: "date-time", nullable: true },
          is_active: { type: "boolean", description: "Computed alias for status === 'active'" },
          held_count: { type: "integer", description: "Outbound messages parked (held) while the channel was down, awaiting drain" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Contact: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          display_name: { type: "string", nullable: true },
          email: { type: "string", format: "email", nullable: true },
          is_subscribed: { type: "boolean" },
          last_interaction_at: { type: "string", format: "date-time", nullable: true },
          tags: {
            type: "array",
            items: { $ref: "#/components/schemas/Tag" },
          },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Tag: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          color: { type: "string", example: "#6366f1" },
        },
      },
      Conversation: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          platform: { type: "string", enum: ["facebook", "instagram", "telegram"] },
          status: { type: "string", enum: ["open", "closed", "snoozed"] },
          last_message_at: { type: "string", format: "date-time", nullable: true },
          last_message_preview: { type: "string", nullable: true },
          unread_count: { type: "integer" },
          is_automation_paused: { type: "boolean" },
          contact: { $ref: "#/components/schemas/Contact" },
          channel: { $ref: "#/components/schemas/Channel" },
        },
      },
      Message: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          direction: { type: "string", enum: ["inbound", "outbound"] },
          text: { type: "string", nullable: true },
          status: {
            type: "string",
            enum: ["pending", "sent", "delivered", "failed", "held", "expired"],
            description: "held = parked while the channel was down; expired = dropped (e.g. outside the messaging window)",
          },
          created_at: { type: "string", format: "date-time" },
        },
      },
      AutoReplyRule: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          is_active: { type: "boolean" },
          priority: { type: "integer" },
          trigger_type: {
            type: "string",
            enum: ["keyword", "comment_keyword", "postback", "welcome", "default", "story_reply", "story_mention", "reaction"],
          },
          trigger_config: { type: "object" },
          response_type: {
            type: "string",
            // Mirrors the writable zod enum on create/patch (no `sequence`): rule-driven enrollment
            // isn't shipped, so the API rejects `sequence` — advertising it here produced a docs/API
            // mismatch where a client POSTing it (per Scalar) got a 400.
            enum: ["text", "random_text", "none", "ai_rephrase", "follow_gate"],
          },
          response_config: { type: "object" },
          cooldown_seconds: { type: "integer" },
          max_sends_per_contact: { type: "integer", nullable: true },
          requires_approval: { type: "boolean", description: "Park the reply for human review instead of sending (text/random_text/ai_rephrase, DM only)" },
        },
      },
      SequenceStep: {
        oneOf: [
          {
            type: "object",
            required: ["type", "content"],
            properties: { type: { type: "string", enum: ["message"] }, content: { type: "string", maxLength: 2000 } },
          },
          {
            type: "object",
            required: ["type", "delay_minutes"],
            properties: { type: { type: "string", enum: ["delay"] }, delay_minutes: { type: "integer", minimum: 1, maximum: 20160 } },
          },
        ],
      },
      Sequence: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          status: { type: "string", enum: ["draft", "active", "archived"] },
          steps: { type: "array", items: { $ref: "#/components/schemas/SequenceStep" } },
          created_at: { type: "string", format: "date-time" },
          _count: { type: "object", properties: { enrollments: { type: "integer" } } },
        },
      },
      ApiKey: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          key_prefix: { type: "string", example: "rs_live_abcd" },
          scopes: { type: "array", items: { type: "string" }, description: "Empty = full access" },
          last_used_at: { type: "string", format: "date-time", nullable: true },
          expires_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: "Missing or invalid authentication",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Error" } },
        },
      },
      NotFound: {
        description: "Resource not found",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Error" } },
        },
      },
    },
  },
  paths: {
    "/health": {
      // Health lives at /api/health, outside the /api/v1 surface — override the server for this
      // path so "Try it out" hits the real endpoint, and document the RAW (unenveloped) shape it
      // actually returns.
      servers: [{ url: "/api", description: "Health endpoint (not under /api/v1)" }],
      get: {
        tags: ["System"],
        summary: "Health check",
        description: "Liveness + database reachability. Returns a raw object (no { data, error } envelope).",
        security: [],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "503": {
            description: "Database unreachable",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "error" },
                    message: { type: "string", example: "Database unreachable" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/channels": {
      get: {
        tags: ["Channels"],
        summary: "List connected channels",
        responses: {
          "200": {
            description: "List of channels",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Channel" } },
                    error: { type: "null" },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/channels/telegram/connect": {
      post: {
        tags: ["Channels"],
        summary: "Connect a Telegram bot by token (no OAuth)",
        description: "Validates the bot token via getMe and registers the webhook. Paste a token from @BotFather.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: { token: { type: "string", example: "123456789:AA..." } },
              },
            },
          },
        },
        responses: {
          "201": { description: "Bot connected" },
          "400": { description: "Invalid bot token or webhook registration failed" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/contacts": {
      get: {
        tags: ["Contacts"],
        summary: "List contacts",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "tag", in: "query", schema: { type: "string" }, description: "Filter by tag name" },
          { name: "q", in: "query", schema: { type: "string" }, description: "Search by name or email" },
        ],
        responses: {
          "200": {
            description: "Paginated contact list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                    error: { type: "null" },
                    meta: { $ref: "#/components/schemas/Pagination" },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/conversations": {
      get: {
        tags: ["Conversations"],
        summary: "List conversations",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "closed", "snoozed"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: {
          "200": {
            description: "Paginated conversation list",
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/rules": {
      get: {
        tags: ["Rules"],
        summary: "List auto-reply rules",
        responses: {
          "200": { description: "List of rules" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Rules"],
        summary: "Create auto-reply rule",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AutoReplyRule" },
            },
          },
        },
        responses: {
          "201": { description: "Rule created" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/approvals": {
      get: {
        tags: ["Approvals"],
        summary: "List replies awaiting human approval",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["pending", "approved", "rejected"], default: "pending" },
          },
        ],
        responses: {
          "200": { description: "List of approvals" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/approvals/{approvalId}/approve": {
      post: {
        tags: ["Approvals"],
        summary: "Approve a parked reply and send it",
        parameters: [{ name: "approvalId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Approved and queued for sending" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { description: "Approval not found" },
          "409": { description: "Already resolved" },
        },
      },
    },
    "/approvals/{approvalId}/reject": {
      post: {
        tags: ["Approvals"],
        summary: "Reject a parked reply (discard, no send)",
        parameters: [{ name: "approvalId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Rejected" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { description: "Approval not found" },
          "409": { description: "Already resolved" },
        },
      },
    },

    // ─── Channels (detail + actions) ──────────────────────────────────────────
    "/channels/connect-token": {
      post: {
        tags: ["Channels"],
        summary: "Mint a short-lived token to connect a channel from the dashboard",
        responses: {
          "200": { description: "Connect token issued" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/channels/{channelId}": {
      parameters: [{ name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Channels"],
        summary: "Get a channel",
        responses: {
          "200": { description: "Channel", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Channel" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Channels"],
        summary: "Update a channel (e.g. pause/resume automation, rename)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string" }, status: { type: "string", enum: ["active", "paused"] } } } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        tags: ["Channels"],
        summary: "Disconnect a channel",
        responses: {
          "204": { description: "Disconnected" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "Channel has sequence enrollments — cancel or complete them first" },
        },
      },
    },
    "/channels/{channelId}/drain": {
      post: {
        tags: ["Channels"],
        summary: "Replay outbound messages parked (held) while the channel was down",
        parameters: [{ name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Drain enqueued" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/channels/{channelId}/posts": {
      get: {
        tags: ["Channels"],
        summary: "List recent posts for a channel (for comment-rule targeting)",
        parameters: [{ name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "List of posts" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ─── Contacts (detail) ────────────────────────────────────────────────────
    "/contacts/{contactId}": {
      parameters: [{ name: "contactId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Contacts"],
        summary: "Get a contact",
        responses: {
          "200": { description: "Contact", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Contact" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Contacts"],
        summary: "Update a contact (name, email, subscription, tags)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string", nullable: true }, email: { type: "string", nullable: true }, is_subscribed: { type: "boolean" }, tag_ids: { type: "array", items: { type: "string", format: "uuid" } } } } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        tags: ["Contacts"],
        summary: "Erase a contact and its personal data (GDPR)",
        responses: {
          "204": { description: "Erased" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ─── Conversations (detail + messages) ────────────────────────────────────
    "/conversations/{conversationId}": {
      parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Conversations"],
        summary: "Get a conversation",
        responses: {
          "200": { description: "Conversation", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Conversation" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Conversations"],
        summary: "Update a conversation (status, automation pause, unread)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed", "snoozed"] }, is_automation_paused: { type: "boolean" }, assigned_to: { type: "string", format: "uuid", nullable: true }, unread_count: { type: "integer", enum: [0] } } } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/conversations/{conversationId}/messages": {
      parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Conversations"],
        summary: "List messages in a conversation",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "ISO timestamp cursor for keyset pagination" },
        ],
        responses: {
          "200": { description: "Messages (chronological)", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Message" } }, error: { type: "null" }, meta: { type: "object", properties: { has_more: { type: "boolean" }, next_cursor: { type: "string", nullable: true } } } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        tags: ["Conversations"],
        summary: "Send a manual reply",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 200 }, description: "Repeat-safe send: the same key sends at most once (≤200 chars)" },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 2000 } } } } } },
        responses: {
          "201": { description: "Queued for sending" },
          "400": { description: "No platform identity / over-long Idempotency-Key" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
    },

    // ─── Rules (detail) ───────────────────────────────────────────────────────
    "/rules/{ruleId}": {
      parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Rules"],
        summary: "Get an auto-reply rule",
        responses: {
          "200": { description: "Rule", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/AutoReplyRule" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Rules"],
        summary: "Update an auto-reply rule",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/AutoReplyRule" } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        tags: ["Rules"],
        summary: "Delete an auto-reply rule",
        responses: {
          "204": { description: "Deleted" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ─── Sequences (drip campaigns) ───────────────────────────────────────────
    "/sequences": {
      get: {
        tags: ["Sequences"],
        summary: "List sequences",
        responses: {
          "200": { description: "List of sequences", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Sequence" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Sequences"],
        summary: "Create a sequence",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "steps"], properties: { name: { type: "string", maxLength: 100 }, description: { type: "string", maxLength: 500 }, steps: { type: "array", minItems: 1, maxItems: 50, items: { $ref: "#/components/schemas/SequenceStep" } } } } } } },
        responses: {
          "201": { description: "Created" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/sequences/{sequenceId}": {
      parameters: [{ name: "sequenceId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        tags: ["Sequences"],
        summary: "Get a sequence",
        responses: {
          "200": { description: "Sequence", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Sequence" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Sequences"],
        summary: "Update a sequence (name, status, steps)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, description: { type: "string", nullable: true }, status: { type: "string", enum: ["draft", "active", "archived"] }, steps: { type: "array", items: { $ref: "#/components/schemas/SequenceStep" } } } } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        tags: ["Sequences"],
        summary: "Delete a sequence",
        responses: {
          "204": { description: "Deleted" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/sequences/{sequenceId}/enroll": {
      post: {
        tags: ["Sequences"],
        summary: "Enroll a contact into a sequence",
        parameters: [{ name: "sequenceId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["contact_id", "channel_id"], properties: { contact_id: { type: "string", format: "uuid" }, channel_id: { type: "string", format: "uuid" } } } } } },
        responses: {
          "201": { description: "Enrolled" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "Already enrolled" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/sequences/{sequenceId}/enrollments/{enrollmentId}": {
      delete: {
        tags: ["Sequences"],
        summary: "Cancel an in-flight sequence enrollment",
        parameters: [
          { name: "sequenceId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "enrollmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Enrollment cancelled (or already terminal)" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ─── API keys ─────────────────────────────────────────────────────────────
    "/api-keys": {
      get: {
        tags: ["API Keys"],
        summary: "List API keys (prefixes only, never the secret)",
        responses: {
          "200": { description: "List of keys", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["API Keys"],
        summary: "Create an API key (full secret returned ONCE on creation)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, expires_at: { type: "string", format: "date-time", nullable: true } } } } } },
        responses: {
          "201": { description: "Created — `data.key` holds the full secret, shown only here" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/api-keys/{keyId}": {
      delete: {
        tags: ["API Keys"],
        summary: "Revoke an API key",
        parameters: [{ name: "keyId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Revoked" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ─── Audit log, retention, workspace, tags ────────────────────────────────
    "/audit-log": {
      get: {
        tags: ["Workspace"],
        summary: "List audit-log entries",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0, maximum: 10000 } },
        ],
        responses: {
          "200": { description: "Audit entries" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/messages/prune": {
      post: {
        tags: ["Workspace"],
        summary: "Manually prune terminal messages older than the workspace retention window",
        responses: {
          "200": { description: "Prune result (counts)" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/webhook-events/prune": {
      post: {
        tags: ["Workspace"],
        summary: "Manually prune the inbound webhook-events log older than N days",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["older_than_days"], properties: { older_than_days: { type: "integer", minimum: 7, maximum: 3650 } } } } } },
        responses: {
          "200": { description: "Prune result (deleted count)" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/workspace": {
      get: {
        tags: ["Workspace"],
        summary: "Get workspace settings",
        responses: {
          "200": { description: "Workspace" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      patch: {
        tags: ["Workspace"],
        summary: "Update workspace settings (e.g. message_retention_days)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, message_retention_days: { type: "integer", minimum: 1, nullable: true } } } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/tags": {
      get: {
        tags: ["Contacts"],
        summary: "List tags",
        responses: {
          "200": { description: "List of tags", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Tag" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Contacts"],
        summary: "Create a tag",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, color: { type: "string", example: "#6366f1" } } } } } },
        responses: {
          "201": { description: "Created" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
  },
  tags: [
    { name: "System", description: "Health and status" },
    { name: "Channels", description: "Connected social media accounts" },
    { name: "Contacts", description: "CRM - contacts and tags" },
    { name: "Conversations", description: "Message threads" },
    { name: "Rules", description: "Auto-reply rules" },
    { name: "Sequences", description: "Drip campaigns" },
    { name: "Approvals", description: "Human-in-the-loop review before sending" },
    { name: "API Keys", description: "Programmatic access tokens" },
    { name: "Workspace", description: "Settings, retention, audit log" },
  ],
};
