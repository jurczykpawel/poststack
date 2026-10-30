/**
 * OpenAPI 3.1 specification for the API v1.
 *
 * Add new endpoints here as they are implemented.
 * Served at GET /api/v1 (JSON) and GET /api/docs (Scalar UI).
 */

import { BRAND } from "@/lib/brand";
import { API_SCOPES, type ApiScope } from "@/lib/auth/scopes";

/** Machine-readable permission metadata for API docs and generated clients. */
const requiresScope = <T extends ApiScope>(scope: T): { "x-required-scope": T } => ({
  "x-required-scope": scope,
});

const cursorParameters = (defaultLimit: number, description = "Opaque cursor from the previous response") => [
  { name: "cursor", in: "query", schema: { type: "string" }, description },
  { name: "limit", in: "query", schema: { type: "integer", default: defaultLimit, minimum: 1, maximum: 100 } },
];
const cursorResponse = (items: Record<string, unknown>, location: "data" | "meta") => ({
  "application/json": { schema: { type: "object", properties: location === "meta" ? {
    data: { type: "array", items }, error: { type: "null" }, meta: { $ref: "#/components/schemas/Pagination" },
  } : {
    data: { type: "object", properties: { items: { type: "array", items }, nextCursor: { type: ["string", "null"] } } }, error: { type: "null" },
  } } },
});

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: `${BRAND.name} API`,
    version: "1.0.0",
    description:
      "Self-hosted social media management API — publishing, inbox auto-replies, and drip sequences for Facebook & Instagram. " +
      `Operational endpoints authenticate with an API key: \`Authorization: Bearer ${BRAND.idPrefix}...\`. ` +
      "Create and manage API keys from a logged-in dashboard session in Settings > API Keys.",
    license: { name: "Elastic License 2.0", url: "https://www.elastic.co/licensing/elastic-license" },
    contact: { url: "https://github.com/jurczykpawel/poststack" },
  },
  servers: [{ url: "/api/v1", description: "Current instance" }],
  security: [{ BearerAuth: [] }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: `API Key (${BRAND.idPrefix}...)`,
        description:
          "API key generated in Settings > API Keys. " +
          `Format: \`Authorization: Bearer ${BRAND.idPrefix}<key>\``,
      },
      SessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: BRAND.cookieName,
        description: "Logged-in dashboard session used for account administration.",
      },
    },
    schemas: {
      Post: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          tiktokPublishMode: { type: ["string", "null"], enum: ["inbox", "direct", null], description: "Null uses inbox/draft. Direct Post requires an explicit privacy choice and current creator permissions." },
          tiktokPrivacyLevel: { type: ["string", "null"], enum: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY", null], description: "No default; checked against creator privacy_level_options before Direct Post." },
          tiktokDisableComment: { type: ["boolean", "null"], description: "Null disables comments; new creator restrictions hold the delivery for renewed confirmation." },
          tiktokDisableDuet: { type: ["boolean", "null"], description: "Null disables Duets; new creator restrictions hold the delivery for renewed confirmation." },
          tiktokDisableStitch: { type: ["boolean", "null"], description: "Null disables Stitches; new creator restrictions hold the delivery for renewed confirmation." },
          tiktokBrandContentToggle: { type: ["boolean", "null"], description: "Paid partnership; cannot use SELF_ONLY. Null means off." },
          tiktokBrandOrganicToggle: { type: ["boolean", "null"], description: "Promotes the creator's own business. Null means off." },
          tiktokCoverTimestampMs: { type: ["integer", "null"], minimum: 0, maximum: 2147483647 },
          scheduledDate: { type: ["string", "null"], format: "date-time", description: "Also set when publishing with a future when; immediate publish leaves it unchanged." },
          delivery: {
            type: ["object", "null"],
            description: "Execution linked to this post; null before a delivery exists. TikTok remains processing until publication or a final failure; held deliveries explain required confirmation in lastError.",
            required: ["id", "channelId", "status", "scheduledFor", "attempts", "lastError", "platformPostId", "updatedAt", "firstComment"],
            properties: {
              id: { type: "string", format: "uuid" },
              channelId: { type: "string", format: "uuid", description: "Connected account used for this delivery." },
              status: { type: "string", enum: ["scheduled", "sending", "processing", "sent", "held", "unknown", "failed", "canceled"] },
              scheduledFor: { type: "string", format: "date-time", description: "Requested publish time (when)." },
              attempts: { type: "integer" },
              lastError: { type: ["string", "null"], description: "Redacted provider error." },
              platformPostId: { type: ["string", "null"] },
              updatedAt: { type: "string", format: "date-time" },
              firstComment: {
                type: "object",
                description: "Existing outbound ledger status takes precedence. Without a row, eligibility is evaluated NOW, not recorded at publish time: awaiting_publish unless sent, then no_text, unlicensed, unsupported_platform in that order. A sent, eligible delivery awaiting its comment worker has not_attempted with no reason.",
                required: ["status", "commentId", "attempts", "lastError"],
                properties: {
                  status: { type: "string", enum: ["pending", "sending", "sent", "failed", "held", "expired", "unknown", "not_attempted"] },
                  reason: { type: "string", enum: ["no_text", "unlicensed", "unsupported_platform", "awaiting_publish"], description: "Only present for not_attempted when a reason applies; based on current request text, channel default, license and provider support." },
                  commentId: { type: ["string", "null"] },
                  attempts: { type: "integer" },
                  lastError: { type: ["string", "null"], description: "Redacted outbound error." },
                },
              },
            },
          },
        },
      },
      Error: {
        type: "object",
        required: ["data", "error"],
        properties: {
          data: { type: "null" },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                description:
                  "Stable machine-readable code (lowercase snake_case). Common values: unauthorized, " +
                  "forbidden, not_found, conflict, bad_request, validation_error, rate_limited, " +
                  "pro_required, internal_error (plus endpoint-specific codes).",
                example: "not_found",
              },
              message: { type: "string", example: "Resource not found" },
              details: {
                description:
                  "On validation_error: an array of { path, message }. On pro_required: { feature, upgrade_url }. Absent otherwise.",
              },
            },
          },
        },
      },
      Pagination: {
        type: "object",
        description: "Cursor pagination meta. Pass next_cursor back as ?cursor= for the next page.",
        properties: {
          has_more: { type: "boolean", example: true },
          next_cursor: { type: ["string", "null"], example: "eyJ0IjoiMjAyNi0wNi0yNVQxMjowMDowMC4wMDBaIiwiaSI6Ii4uLiJ9" },
        },
      },
      Channel: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          platform: { type: "string", enum: ["facebook", "instagram", "youtube", "gmail", "telegram"] },
          platform_id: { type: "string", description: "Platform-native account id (e.g. IG business account id / FB page id)." },
          display_name: { type: "string", example: "My Business Page" },
          username: { type: "string", nullable: true },
          profile_picture: { type: "string", format: "uri", nullable: true },
          status: { type: "string", enum: ["active", "needs_reauth", "paused", "disabled"] },
          connection_mode: { type: "string", enum: ["oauth", "manual_token", "derived"], description: "manual_token = pasted long-lived/System User token, not auto-refreshed" },
          last_error: { type: "string", nullable: true },
          last_health_at: { type: "string", format: "date-time", nullable: true },
          is_active: { type: "boolean", description: "Computed alias for status === 'active'" },
          held_count: { type: "integer", description: "Outbound messages parked (held) while the channel was down, awaiting drain" },
          messaging_token_expires_at: { type: "string", format: "date-time", nullable: true, description: "Instagram-Login messaging token expiry (IG channels with Instagram Business Login)." },
          messaging_connection: { type: "string", enum: ["instagram_login", "facebook_only"], nullable: true, description: "IG messaging credential shape: instagram_login (DMs via Instagram Login) or facebook_only (IG DM receipt not guaranteed at Standard Access)." },
          capabilities: { type: "array", items: { type: "string", enum: ["publish", "comment_reply", "dm", "poll_comments", "receive_webhooks", "enumerate_subaccounts"] }, description: "Computed capabilities for this channel." },
          missing_publish_scopes: { type: "array", items: { type: "string" }, description: "Known missing publishing permissions; reconnect the channel to grant them. Empty when scopes are unknown or sufficient." },
          can_publish: { type: "boolean", description: "Whether this channel can publish posts (true when capabilities include 'publish'). False for inbox-only channels such as Telegram." },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Contact: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          display_name: { type: "string", nullable: true },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true },
          is_subscribed: { type: "boolean" },
          last_interaction_at: { type: "string", format: "date-time", nullable: true },
          tags: {
            type: "array",
            items: { $ref: "#/components/schemas/Tag" },
          },
          created_at: { type: "string", format: "date-time" },
        },
      },
      ContactImport: {
        type: "object",
        required: ["channel_id"],
        description:
          "One contact to import. Provide platform_sender_id, or platform_username when only a handle " +
          "is known (it is keyed as a placeholder sender id until the contact's first inbound event).",
        properties: {
          channel_id: { type: "string", format: "uuid" },
          platform_sender_id: { type: "string" },
          platform_username: { type: "string" },
          display_name: { type: "string", nullable: true },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true },
          is_subscribed: { type: "boolean", default: true },
          metadata: { type: "object", additionalProperties: true, description: "Custom fields, merged on re-import" },
          tags: { type: "array", items: { type: "string" }, description: "Tag names; created if missing" },
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
          is_active: { type: "boolean", default: true, description: "Whether the rule is active; can be set when creating or updating a rule" },
          priority: { type: "integer" },
          trigger_type: {
            type: "string",
            enum: ["keyword", "comment_keyword", "postback", "welcome", "default", "story_reply", "story_mention", "reaction"],
          },
          trigger_config: { type: "object" },
          response_type: {
            type: "string",
            // Mirrors the writable zod enum on create/patch. `sequence` enrolls the matched contact
            // into a drip — it requires `response_config.sequence_id` pointing at an active sequence.
            enum: ["text", "random_text", "none", "ai_rephrase", "follow_gate", "sequence"],
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
          key_prefix: { type: "string", example: `${BRAND.idPrefix}abcd` },
          scopes: {
            type: "array",
            items: { type: "string", enum: API_SCOPES },
            description: "Empty = full access; otherwise each operation requires its documented permission.",
          },
          last_used_at: { type: "string", format: "date-time", nullable: true },
          expires_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      WebhookDelivery: {
        type: "object",
        required: ["id", "event_id", "event_type", "status", "attempts", "http_status", "last_error", "created_at", "updated_at", "next_attempt_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          event_id: { type: "string", format: "uuid", description: "Original webhook envelope id; correlate retries and receiver logs with this value." },
          event_type: { type: "string" },
          status: { type: "string", enum: ["pending", "delivering", "delivered", "failed"] },
          attempts: { type: "integer", minimum: 0 },
          http_status: { type: "integer", nullable: true, description: "Last completed attempt's HTTP code; null before an attempt, on a transport error, or for older records." },
          last_error: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          next_attempt_at: { type: "string", format: "date-time", nullable: true, description: "Actual queue schedule in UTC; null while running, when no job is queued, or after completion." },
        },
      },
      WebhookEndpoint: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          url: { type: "string", format: "uri" },
          event_types: { type: "array", items: { type: "string" }, description: "Empty = subscribe to all event types" },
          active: { type: "boolean" },
          header_names: { type: "array", items: { type: "string" }, description: "Names of the configured custom headers (never values — set-only via `headers` on create/PATCH)." },
          extra_payload_fields: { type: "object", additionalProperties: true, description: "Extra top-level fields merged into every delivered body. Not secret — returned in full. String leaves support {{id}} {{type}} {{created_at}} {{subject_id}} {{subject_type}} placeholders." },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          secret: { type: "string", example: "whsec_…", description: "HMAC signing secret. Returned ONLY on create and rotate-secret — store it then; it is never echoed by GET." },
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
      InsufficientScope: {
        description: "Valid API key missing the required scope. error.code is insufficient_scope; error.message names the scope. Instance-operator operations can also return forbidden when an operator session is required.",
        content: { "application/json": {
          schema: { $ref: "#/components/schemas/Error" },
          example: { data: null, error: { code: "insufficient_scope", message: "This operation requires brands:read" } },
        } },
      },
      Forbidden: {
        description: "The active authentication method cannot perform this operation",
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
      ProRequired: {
        description: "A PRO license is required for this feature",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Error" } },
        },
      },
    },
  },
  paths: {
    // ── Publishing (editorial content + posts + media + brands) ──────────────────────
    "/content": {
      get: {
        ...requiresScope("content:read"),
        tags: ["Publishing"],
        summary: "List editorial content (keyset paginated)",
        parameters: cursorParameters(20),
        responses: { "200": { description: "List of content", content: cursorResponse({ type: "object" }, "data") }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      post: {
        ...requiresScope("content:write"),
        tags: ["Publishing"],
        summary: "Create editorial content",
        responses: { "201": { description: "Created" }, "401": { $ref: "#/components/responses/Unauthorized" }, "422": { description: "Validation error" } },
      },
    },
    "/content/{contentId}": {
      get: {
        ...requiresScope("content:read"),
        tags: ["Publishing"],
        summary: "Get editorial content",
        description: "The content record requires content:read. Related posts are included only when the caller also has posts:read.",
        responses: { "200": { description: "Content" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      patch: {
        ...requiresScope("content:write"),
        tags: ["Publishing"],
        summary: "Update content",
        responses: { "200": { description: "Updated" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      delete: {
        ...requiresScope("content:write"),
        tags: ["Publishing"],
        summary: "Delete content",
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/posts": {
      get: {
        ...requiresScope("posts:read"),
        tags: ["Publishing"],
        summary: "List editorial posts",
        parameters: cursorParameters(20),
        responses: { "200": { description: "List of posts", content: cursorResponse({ $ref: "#/components/schemas/Post" }, "data") }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      post: {
        ...requiresScope("posts:write"),
        tags: ["Publishing"],
        summary: "Create an editorial post",
        description:
          "Body accepts tiktokPublishMode/tiktokPrivacyLevel/tiktokDisableComment/tiktokDisableDuet/tiktokDisableStitch/" +
          "tiktokBrandContentToggle/tiktokBrandOrganicToggle/tiktokCoverTimestampMs (saved TikTok choices), and youtubePrivacy/youtubeTags/youtubeCategoryId/youtubeMadeForKids (YouTube publish " +
          "options) and aiDisclosure/aiDisclosureNote (declared AI-involvement level + optional in-content note; " +
          "the resulting per-platform disclosure evidence is server-written, not accepted here).",
        responses: { "201": { description: "Created" }, "401": { $ref: "#/components/responses/Unauthorized" }, "422": { description: "Validation error" } },
      },
    },
    "/posts/{postId}": {
      get: {
        ...requiresScope("posts:read"),
        tags: ["Publishing"],
        summary: "Get a post",
        responses: { "200": { description: "Post", content: { "application/json": { schema: {
          type: "object", properties: { data: { $ref: "#/components/schemas/Post" }, error: { type: "null" } },
        } } } }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      patch: {
        ...requiresScope("posts:write"),
        tags: ["Publishing"],
        summary: "Update a post",
        description: "Same body as create (all fields optional), including YouTube options and AI-disclosure fields. scheduledDate reschedules the linked pending delivery and publish job atomically. Returns 409 if the delivery is already publishing or no longer pending. Saved publishing options remain unchanged.",

        responses: { "200": { description: "Updated" }, "409": { description: "Delivery no longer pending" }, "422": { description: "Invalid schedule" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      delete: {
        ...requiresScope("posts:write"),
        tags: ["Publishing"],
        summary: "Delete a post",
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/deliveries/{deliveryId}/reschedule": {
      post: {
        ...requiresScope("posts:write"), tags: ["Publishing"],
        summary: "Change a pending delivery's schedule",
        description: "Only scheduled and held deliveries can change; held becomes scheduled. TikTok deliveries awaiting renewed consent must be confirmed in Queue first. Updates the linked editorial date and replaces the publish job atomically. Saved publish settings and consent remain unchanged.",
        parameters: [{ name: "deliveryId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["scheduledAt"], properties: { scheduledAt: { type: "string", format: "date-time" } } } } } },
        responses: { "200": { description: "Rescheduled delivery in data" }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { description: "Delivery not found" }, "409": { description: "Already publishing or no longer pending" }, "422": { description: "Invalid or past date (same five-minute skew as creation)" } },
      },
    },
    "/posts/{postId}/publish": {
      post: {
        ...requiresScope("posts:write"),
        tags: ["Publishing"],
        summary: "Publish or schedule a post through the delivery engine",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["channelId"], properties: { channelId: { type: "string", format: "uuid" }, when: { type: "string", example: "now" }, format: { type: "string" } } } } } },
        responses: { "200": { description: "Delivery created + linked" }, "404": { description: "Not found" }, "409": { description: "Already published" }, "422": { description: "Validation error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/media": {
      post: {
        ...requiresScope("media:write"),
        tags: ["Publishing"],
        summary: "Register a media URL into content-addressed storage",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } } } },
        responses: { "201": { description: "Media registered" }, "400": { description: "Media ingest error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/brands": {
      get: {
        ...requiresScope("brands:read"),
        tags: ["Publishing"],
        summary: "List brands",
        responses: { "200": { description: "List of brands" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      post: {
        ...requiresScope("brands:write"),
        tags: ["Publishing"], summary: "Create a brand",
        description:
          "Accepts `default_ai_disclosure` (`none` | `ai_assisted` | `ai_generated`) and " +
          "`default_ai_disclosure_note` — the brand-wide AI declaration inherited by any post that sets " +
          "none of its own (resolution order: post → channel → brand). Null on both = this brand declares nothing.",
        responses: { "201": { description: "Created" }, "409": { description: "Already exists" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/brands/{brandKey}/channels": {
      get: {
        ...requiresScope("brands:read"),
        tags: ["Publishing"],
        summary: "Resolve this brand's channel per editorial platform",
        description:
          "Returns one slot per editorial platform: `{ platform, channel: { id, label } | null, ambiguous }`. " +
          "`channel: null` means unmapped, or ambiguous (`ambiguous: true` — several candidates, so resolution refuses to guess). " +
          "Use the returned `channel.id` as `channelId` when calling POST /posts/{postId}/publish.",
        responses: {
          "200": { description: "Per-platform resolution slots" },
          "404": { description: "Brand not registered in this workspace" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/brands/{brandKey}": {
      patch: {
        ...requiresScope("brands:write"),
        tags: ["Publishing"],
        summary: "Update a brand",
        responses: { "200": { description: "Updated" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      delete: {
        ...requiresScope("brands:write"),
        tags: ["Publishing"],
        summary: "Delete a brand (unassigns its channels)",
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
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
        ...requiresScope("channels:read"),
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
        ...requiresScope("channels:write"),
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
        ...requiresScope("contacts:read"),
        tags: ["Contacts"],
        summary: "List contacts",
        parameters: [
          ...cursorParameters(30),
          { name: "tag", in: "query", schema: { type: "string" }, description: "Filter by tag name" },
          { name: "q", in: "query", schema: { type: "string" }, description: "Search by name or email" },
        ],
        responses: {
          "200": {
            description: "Paginated contact list",
            content: cursorResponse({ $ref: "#/components/schemas/Contact" }, "meta"),
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        ...requiresScope("contacts:write"),
        tags: ["Contacts"],
        summary: "Create or import contacts",
        description:
          "Create or update one contact, or a batch (send an array, up to 1000). Idempotent: dedup is by " +
          "channel + sender id, so re-running the same payload updates instead of duplicating. Intended for " +
          "migrating a subscriber list (e.g. a ManyChat audience export). Requires the contacts CRM (Pro).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/ContactImport" },
                  { type: "array", items: { $ref: "#/components/schemas/ContactImport" }, minItems: 1, maxItems: 1000 },
                ],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Import summary (per-row results; unknown channels are reported, not fatal)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        created: { type: "integer" },
                        updated: { type: "integer" },
                        failed: { type: "integer" },
                        results: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              index: { type: "integer" },
                              status: { type: "string", enum: ["created", "updated", "error"] },
                              contact_id: { type: "string", format: "uuid" },
                              error: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                    error: { type: "null" },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/conversations": {
      get: {
        ...requiresScope("conversations:read"),
        tags: ["Conversations"],
        summary: "List conversations",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "closed", "snoozed"] } },
          ...cursorParameters(30),
          { name: "channel_id", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": {
            description: "Paginated conversation list",
            content: cursorResponse({ type: "object" }, "meta"),
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/rules": {
      get: {
        ...requiresScope("rules:read"),
        tags: ["Rules"],
        summary: "List auto-reply rules",
        responses: {
          "200": { description: "List of rules" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        ...requiresScope("rules:write"),
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
        ...requiresScope("conversations:read"),
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
          "200": { description: "List of approvals. Existing fields are retained; inboundMessageId and inboundCommentId identify the originating inbox message or comment log, respectively (null for older records or after source removal).", content: { "application/json": { schema: {
            type: "object", properties: { data: { type: "array", items: { type: "object", properties: {
              inboundMessageId: { type: "string", format: "uuid", nullable: true },
              inboundCommentId: { type: "string", format: "uuid", nullable: true },
            }, additionalProperties: true } }, error: { type: "null" } },
          } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/approvals/{approvalId}/approve": {
      post: {
        ...requiresScope("conversations:write"),
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
        ...requiresScope("conversations:write"),
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
        ...requiresScope("channels:write"),
        tags: ["Channels"],
        summary: "Mint a short-lived token to connect a channel from the dashboard",
        responses: {
          "200": { description: "Connect token issued" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/sources": {
      get: {
        ...requiresScope("sources:read"),
        tags: ["Channels"],
        summary: "List managed connections (Meta master tokens) and their derived channels — PRO",
        responses: {
          "200": { description: "Managed connections" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
        },
      },
      post: {
        ...requiresScope("sources:write"),
        tags: ["Channels"],
        summary: "Connect/reconnect a managed connection from a pasted User/System-User token — PRO",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } } },
        responses: {
          "201": { description: "Connected; all Pages + linked Instagram minted as derived channels" },
          "400": { description: "Token rejected (foreign app / invalid / expired / wrong type / missing scope)" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/sources/{sourceId}": {
      delete: {
        ...requiresScope("sources:write"),
        tags: ["Channels"],
        summary: "Remove a managed connection (derived channels survive as standalone) — PRO",
        parameters: [{ name: "sourceId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Removed" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/sources/{sourceId}/sync": {
      post: {
        ...requiresScope("sources:write"),
        tags: ["Channels"],
        summary: "Re-enumerate a managed connection now (new Pages/IG appear) — PRO",
        parameters: [{ name: "sourceId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Synced" },
          "400": { description: "Master token invalid — reconnect with a fresh token" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/channels/{channelId}": {
      parameters: [{ name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        ...requiresScope("channels:read"),
        tags: ["Channels"],
        summary: "Get a channel",
        responses: {
          "200": { description: "Channel", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Channel" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        ...requiresScope("channels:write"),
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
        ...requiresScope("channels:write"),
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
        ...requiresScope("channels:write"),
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
    "/channels/{channelId}/gmail-filter": {
      post: {
        ...requiresScope("channels:write"),
        tags: ["Channels"],
        summary: "Save the Gmail ingest filter query for a Gmail channel",
        parameters: [{ name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: { query: { type: "string", maxLength: 1000, description: "Raw Gmail search query (e.g. 'label:Support from:vip@x.com'). Empty string clears the filter." } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Filter saved" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error — query not a string or exceeds 1000 characters" },
        },
      },
    },
    "/channels/{channelId}/tiktok/creator-info": {
      get: {
        ...requiresScope("channels:read"),
        tags: ["Channels"],
        summary: "Query TikTok creator profile and current Direct Post permissions",
        description: "Uses a process-local 60-second cache per workspace/channel/credentials. Set refresh=true to query TikTok again. Posting limits return cannot_post_now with a reason and try-again-later message. Requires video.publish permission on the connected TikTok account.",
        parameters: [
          { name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "refresh", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": {
            description: "Creator permissions or temporary posting restriction",
            content: { "application/json": { schema: {
              type: "object", required: ["data", "error"], properties: {
                error: { type: "null" },
                data: { oneOf: [
                  { type: "object", required: ["status", "creator_info"], properties: {
                    status: { type: "string", enum: ["available"] },
                    creator_info: { type: "object", required: ["creator_nickname", "creator_avatar_url", "privacy_level_options", "comment_disabled", "duet_disabled", "stitch_disabled"], properties: {
                      creator_nickname: { type: "string" }, creator_username: { type: "string" },
                      creator_avatar_url: { type: "string" },
                      privacy_level_options: { type: "array", items: { type: "string" } },
                      comment_disabled: { type: "boolean" }, duet_disabled: { type: "boolean" }, stitch_disabled: { type: "boolean" },
                      max_video_post_duration_sec: { type: "integer", minimum: 1 },
                    } },
                  } },
                  { type: "object", required: ["status", "reason", "message"], properties: {
                    status: { type: "string", enum: ["cannot_post_now"] },
                    reason: { type: "string", enum: ["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap"] },
                    message: { type: "string" },
                  } },
                ] },
              },
            } } },
          },
          "400": { description: "Invalid refresh value, non-TikTok channel, or channel reconnection required" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { description: "TikTok request rate limit exceeded" },
          "503": { description: "TikTok creator info unavailable; try again later" },
        },
      },
    },
    "/channels/{channelId}/posts": {
      get: {
        ...requiresScope("channels:read"),
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
        ...requiresScope("contacts:read"),
        tags: ["Contacts"],
        summary: "Get a contact",
        responses: {
          "200": { description: "Contact", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Contact" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        ...requiresScope("contacts:write"),
        tags: ["Contacts"],
        summary: "Update a contact (name, email, subscription, tags)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string", nullable: true }, email: { type: "string", nullable: true }, phone: { type: "string", nullable: true }, is_subscribed: { type: "boolean" }, tag_ids: { type: "array", items: { type: "string", format: "uuid" } } } } } } },
        responses: {
          "200": { description: "Updated" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        ...requiresScope("contacts:write"),
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
        ...requiresScope("conversations:read"),
        tags: ["Conversations"],
        summary: "Get a conversation",
        responses: {
          "200": { description: "Conversation", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Conversation" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        ...requiresScope("conversations:write"),
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
        ...requiresScope("conversations:read"),
        tags: ["Conversations"],
        summary: "List messages in a conversation",
        parameters: [
          ...cursorParameters(50, "ISO timestamp from meta.next_cursor"),
        ],
        responses: {
          "200": { description: "Messages (chronological)", content: cursorResponse({ $ref: "#/components/schemas/Message" }, "meta") },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        ...requiresScope("conversations:write"),
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
        ...requiresScope("rules:read"),
        tags: ["Rules"],
        summary: "Get an auto-reply rule",
        responses: {
          "200": { description: "Rule", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/AutoReplyRule" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        ...requiresScope("rules:write"),
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
        ...requiresScope("rules:write"),
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
        ...requiresScope("sequences:read"),
        tags: ["Sequences"],
        summary: "List sequences",
        responses: {
          "200": { description: "List of sequences", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Sequence" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        ...requiresScope("sequences:write"),
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
        ...requiresScope("sequences:read"),
        tags: ["Sequences"],
        summary: "Get a sequence",
        responses: {
          "200": { description: "Sequence", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Sequence" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        ...requiresScope("sequences:write"),
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
        ...requiresScope("sequences:write"),
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
        ...requiresScope("sequences:write"),
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
        ...requiresScope("sequences:write"),
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
        security: [{ SessionCookie: [] }],
        tags: ["API Keys"],
        summary: "List API keys (prefixes only, never the secret)",
        responses: {
          "200": { description: "List of keys", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
      post: {
        security: [{ SessionCookie: [] }],
        tags: ["API Keys"],
        summary: "Create an API key (full secret returned ONCE on creation)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "scopes"], properties: { name: { type: "string" }, scopes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: API_SCOPES } }, expires_at: { type: "string", format: "date-time", nullable: true } } } } } },
        responses: {
          "201": { description: "Created — `data.key` holds the full secret, shown only here" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/api-keys/{keyId}": {
      delete: {
        security: [{ SessionCookie: [] }],
        tags: ["API Keys"],
        summary: "Revoke an API key",
        parameters: [{ name: "keyId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Revoked" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ─── Audit log, retention, workspace, tags ────────────────────────────────
    "/stats/response-times": {
      get: {
        ...requiresScope("stats:read"),
        tags: ["Stats"],
        summary: "Response-time stats: answer rate, average latency and first-response percentiles",
        description:
          "Overall plus per-thread-type and per-platform breakdowns over a trailing window. Numbers union the live metrics with the rolled-up daily stats, so they are unaffected by history compaction.",
        parameters: [
          { name: "window", in: "query", description: "Trailing window in days", schema: { type: "integer", default: 30, minimum: 1, maximum: 365 } },
        ],
        responses: {
          "200": { description: "Response-time stats" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/audit-log": {
      get: {
        ...requiresScope("settings:read"),
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
        ...requiresScope("settings:write"),
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
        ...requiresScope("settings:write"),
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
        ...requiresScope("settings:read"),
        tags: ["Workspace"],
        summary: "Get workspace settings",
        responses: {
          "200": { description: "Workspace" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      patch: {
        ...requiresScope("settings:write"),
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
    "/license": {
      get: {
        ...requiresScope("settings:read"),
        tags: ["License"],
        summary: "Get the instance license + capability status (tier, features, ai_configured; never the token)",
        description:
          "Returns { tier, status, expires_at, source, features, upgrade_url, ai_configured }. `ai_configured` is true when an AI provider key is set: the AI-dependent features (`ai_draft`, `rephrase`) only run when they are BOTH present in `features` (PRO) AND `ai_configured` is true — check both before relying on AI drafts/rephrasing.",
        responses: {
          "200": { description: "Instance license + capability status" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        ...requiresScope("settings:write"),
        tags: ["License"],
        summary: "Verify and store a Sellf license token",
        description: "Requires an instance operator session. Workspace API keys cannot manage the instance license.",
        security: [{ SessionCookie: [] }],
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } } },
        responses: {
          "200": { description: "License activated" },
          "403": { description: "Instance operator session required" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Invalid license token" },
        },
      },
      delete: {
        ...requiresScope("settings:write"),
        tags: ["License"],
        summary: "Remove the stored license token (revert to env/free)",
        description: "Requires an instance operator session. Workspace API keys cannot manage the instance license.",
        security: [{ SessionCookie: [] }],
        responses: {
          "200": { description: "License removed" },
          "403": { description: "Instance operator session required" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/tags": {
      get: {
        ...requiresScope("tags:read"),
        tags: ["Contacts"],
        summary: "List tags",
        responses: {
          "200": { description: "List of tags", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Tag" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        ...requiresScope("tags:write"),
        tags: ["Contacts"],
        summary: "Create a tag",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, color: { type: "string", example: "#6366f1" } } } } } },
        responses: {
          "201": { description: "Created" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "409": { description: "A tag with this name already exists" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/tags/{tagId}": {
      patch: {
        ...requiresScope("tags:write"),
        tags: ["Contacts"],
        summary: "Rename or recolor a tag",
        parameters: [{ name: "tagId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, color: { type: "string", example: "#6366f1" } } } } } },
        responses: {
          "200": { description: "Updated", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Tag" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "A tag with this name already exists" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        ...requiresScope("tags:write"),
        tags: ["Contacts"],
        summary: "Delete a tag (removes it from all contacts)",
        parameters: [{ name: "tagId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/webhooks": {
      get: {
        ...requiresScope("webhooks:read"),
        tags: ["Webhooks"],
        summary: "List outbound webhook endpoints",
        description: "Requires a PRO license. Signing secrets are not included.",
        responses: {
          "200": { description: "List of endpoints", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/WebhookEndpoint" } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
        },
      },
      post: {
        ...requiresScope("webhooks:write"),
        tags: ["Webhooks"],
        summary: "Register a webhook endpoint",
        description: "Subscribe a URL to events. Returns the HMAC signing secret ONCE. Requires a PRO license. contact.erased provides data.id, workspaceId and channels [{channelId, platform, platformSenderId}] captured before deletion; GET contact then returns 404. conversation.updated provides data.conversationId, contactId, channelId, workspaceId, updatedAt (UTC), previous and current states ({status: open|closed|snoozed, is_automation_paused, assigned_to}). State events include automatic reopening by an incoming message or comment, and exclude read receipts, unchanged values and message activity without a state change. Both types are selectable explicitly and included in wildcard subscriptions ([]).",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, event_types: { type: "array", items: { type: "string" }, description: "Omit/empty for all events" }, headers: { type: "object", additionalProperties: { type: "string" }, description: "Custom HTTP headers merged into every delivery (e.g. an Authorization token). Encrypted at rest." }, extra_payload_fields: { type: "object", additionalProperties: true, description: "Extra top-level fields merged into every delivered body." } } } } } },
        responses: {
          "201": { description: "Created (includes the signing secret once)", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/WebhookEndpoint" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "422": { description: "Validation error (bad URL or unknown event type)" },
        },
      },
    },
    "/webhooks/{webhookId}": {
      get: {
        ...requiresScope("webhooks:read"),
        tags: ["Webhooks"],
        summary: "Get a webhook endpoint",
        parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "The endpoint", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/WebhookEndpoint" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        ...requiresScope("webhooks:write"),
        tags: ["Webhooks"],
        summary: "Update a webhook endpoint",
        parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { url: { type: "string", format: "uri" }, event_types: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, headers: { type: "object", additionalProperties: { type: "string" }, description: "Replaces the configured custom headers. Omit to leave them untouched; {} clears them." }, extra_payload_fields: { type: "object", additionalProperties: true, description: "Replaces the extra payload fields." } } } } } },
        responses: {
          "200": { description: "Updated", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/WebhookEndpoint" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error" },
        },
      },
      delete: {
        ...requiresScope("webhooks:write"),
        tags: ["Webhooks"],
        summary: "Delete a webhook endpoint",
        parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/webhooks/{webhookId}/deliveries": {
      get: {
        ...requiresScope("webhooks:read"),
        tags: ["Webhooks"],
        summary: "List webhook delivery outcomes",
        description: "Requires PRO. Workspace-scoped delivery lifecycles, newest first by (created_at, id). Each row summarizes all attempts for one event and endpoint; no signing secrets, request headers or payloads are returned.",
        parameters: [
          { name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "cursor", in: "query", description: "Opaque next_cursor from the previous page.", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delivery outcomes and cursor pagination", content: { "application/json": { schema: {
            type: "object", properties: {
              data: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } },
              error: { type: "null" },
              meta: { type: "object", properties: { has_more: { type: "boolean" }, next_cursor: { type: "string", nullable: true } } },
            },
          } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Invalid cursor or limit" },
        },
      },
    },
    "/webhooks/{webhookId}/rotate-secret": {
      post: {
        ...requiresScope("webhooks:write"),
        tags: ["Webhooks"],
        summary: "Rotate a webhook signing secret",
        description: "Mints a new signing secret (the previous one stays valid during a grace window). Returns the new secret ONCE.",
        parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Rotated (includes the new signing secret once)", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/WebhookEndpoint" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "402": { $ref: "#/components/responses/ProRequired" },
          "404": { $ref: "#/components/responses/NotFound" },
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
    { name: "Stats", description: "Aggregate metrics (response times, answer rate)" },
    { name: "Webhooks", description: `Outbound event webhooks require PRO. Register a URL and retain the signing secret returned once on creation. An empty event_types array subscribes to every catalog event, including future additions.

### Envelope and delivery
The default JSON envelope is { id, type, created_at, data }. id is the event UUID for deduplication, type is the event name, created_at is the event timestamp in UTC, and data.id / data.type identify the subject. Post subjects use the editorial post ID from GET /posts/{id} (legacy deliveries without an editorial post use the delivery ID). Event-specific fields are inside data. Payload changes are additive; accept unknown fields. Custom extra_payload_fields can override envelope fields, so the following contract describes the default body.

POSTs use Content-Type: application/json, X-PostStack-Event and X-PostStack-Timestamp. Verify \`X-PostStack-Signature: t=<unix>,v1=<hmac>\` by computing HMAC-SHA256 in hexadecimal over timestamp.raw-body (the decimal timestamp, a literal dot, then the exact raw request bytes), using the endpoint secret. Compare in constant time before parsing JSON, check timestamp freshness (e.g. 300 seconds), and accept any matching v1 value during secret rotation. Do not reserialize JSON before verification.

A 2xx response acknowledges delivery. Non-2xx responses, network failures and the 10-second timeout retry with exponential backoff for up to 8 attempts total. The final failed attempt is retained as failed. Delivery is at least once: deduplicate by envelope id, acknowledge quickly, and process asynchronously. Ordering between events is not guaranteed; a retry signs with a new delivery timestamp but keeps the event id and created_at.

### Event data catalog
Every event includes data.id and data.type. Fields below are additional data fields; nullable results remain null until known.

| Event | Subject and data fields |
| --- | --- |
| \`post.published\` | post: workspaceId, channelId, platform, status=published, deliveryId, providerHandle (platform post ID), publishedAt (UTC), firstComment {status, commentId, attempts, lastError, reason?}. firstComment is a snapshot at emission; not_attempted without a reason means the comment is eligible and awaiting its worker. Skip reasons: no_text, unlicensed, unsupported_platform. |
| \`post.first_comment\` | post: workspaceId, channelId, platform, status (publication status), deliveryId, providerHandle, firstComment {status=sent or failed, commentId, reason}. Emitted after comment success or terminal failure; intermediate retries do not emit failed. Published events and this result may arrive out of order. |
| \`post.failed\` | post: workspaceId, channelId, platform, status=failed, deliveryId, error (existing provider error), reason (same error). |
| \`post.held\` | post: workspaceId, channelId, platform, status=held, deliveryId, reason; confirmationUrl when renewed confirmation is required. |
| \`post.unknown\` | post: workspaceId, channelId, platform, status=unknown, deliveryId, reason. Provider outcome needs reconciliation. |
| \`contact.created\` | contact: workspaceId, channels [{channelId, platform, platformSenderId}]. Snapshot of every linked platform identity, as available in GET /contacts/{id}. |
| \`contact.updated\` | contact: workspaceId, channels [{channelId, platform, platformSenderId}]. Identity snapshot at the update, not a changed-fields diff; fetch the contact for its current details. |
| \`channel.created\` | channel: platform, displayName. |
| \`channel.reconnected\` | channel: platform, displayName. |
| \`channel.needs_reauth\` | channel: platform, displayName. |
| \`source.connected\` | account source: id and type; reserved catalog event, no additional data fields guaranteed. |
| \`source.synced\` | account source: id and type; reserved catalog event, no additional data fields guaranteed. |
| \`source.needs_reauth\` | account source: id and type; reserved catalog event, no additional data fields guaranteed. |
| \`source.data_access_expiring\` | account source: id and type; reserved catalog event, no additional data fields guaranteed. |
` },
  ],
};

for (const methods of Object.values(openApiSpec.paths)) {
  for (const operation of Object.values(methods)) {
    const op = operation as { "x-required-scope"?: ApiScope; responses?: Record<string, unknown> };
    if (op["x-required-scope"] && op.responses) {
      op.responses["403"] = { $ref: "#/components/responses/InsufficientScope" };
    }
  }
}
