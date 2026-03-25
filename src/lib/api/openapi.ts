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
          platform: { type: "string", enum: ["facebook", "instagram"] },
          display_name: { type: "string", example: "My Business Page" },
          username: { type: "string", nullable: true },
          profile_picture: { type: "string", format: "uri", nullable: true },
          is_active: { type: "boolean" },
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
          platform: { type: "string", enum: ["facebook", "instagram"] },
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
          status: { type: "string", enum: ["pending", "sent", "delivered", "failed"] },
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
            enum: ["keyword", "comment_keyword", "postback", "welcome", "default", "story_reply", "story_mention"],
          },
          trigger_config: { type: "object" },
          response_type: { type: "string", enum: ["text", "random_text", "sequence", "none"] },
          response_config: { type: "object" },
          cooldown_seconds: { type: "integer" },
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
      get: {
        tags: ["System"],
        summary: "Health check",
        security: [],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        status: { type: "string", example: "ok" },
                        timestamp: { type: "string", format: "date-time" },
                      },
                    },
                    error: { type: "null" },
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
  },
  tags: [
    { name: "System", description: "Health and status" },
    { name: "Channels", description: "Connected social media accounts" },
    { name: "Contacts", description: "CRM - contacts and tags" },
    { name: "Conversations", description: "Message threads" },
    { name: "Rules", description: "Auto-reply rules" },
  ],
};
