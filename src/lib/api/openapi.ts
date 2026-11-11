/**
 * OpenAPI 3.1 specification for the API v1.
 *
 * Add new endpoints here as they are implemented.
 * Served at GET /api/v1 (JSON) and GET /api/docs (Scalar UI).
 */

import { PUBLISHING_OAUTH_KEYS } from "@/lib/settings/publishing-oauth";
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

const publishingOAuthResponse = {
  description: "Publishing OAuth setting statuses; secret previews are masked.",
  content: { "application/json": { schema: { type: "object", required: ["data", "error"], properties: {
    error: { type: "null" },
    data: { type: "array", items: { type: "object", required: ["key", "group", "label", "secret", "source", "preview"], properties: {
      key: { type: "string", enum: PUBLISHING_OAUTH_KEYS }, group: { type: "string" }, label: { type: "string" },
      secret: { type: "boolean" }, source: { type: "string", enum: ["db", "env", "unset"] }, preview: { type: "string" }, help: { type: "string" },
    } } },
  } } } },
};

const providerFields = { provider: { type: "string", enum: ["openai", "anthropic", "openrouter", "groq", "custom"] }, model: { type: "string", minLength: 1, maxLength: 200 }, base_url: { type: "string", maxLength: 300 }, api_key: { type: "string", minLength: 1, maxLength: 500, writeOnly: true } };
const providerInputSchema = { type: "object", additionalProperties: false, properties: providerFields };
const providerPublicSchema = { type: "object", properties: { id: { type: "string", format: "uuid" }, position: { type: "integer", minimum: 1 }, provider: providerFields.provider, model: providerFields.model, base_url: providerFields.base_url, api_key_hint: { type: "string", maxLength: 4 }, last_test_status: { type: "string", enum: ["untested", "ok", "invalid_key", "model_not_found", "rate_limited", "no_credits", "timeout", "unreachable", "blocked_target", "bad_response", "invalid_request"] }, last_test_at: { type: ["string", "null"], format: "date-time" }, answering_now: { type: "boolean" } } };
const providerEndpoint = (summary: string, write: boolean, schema?: object, result: object = { type: "array", items: providerPublicSchema }, row = false) => ({
  ...requiresScope(write ? "instance_ai:write" : "instance_ai:read"), tags: ["AI providers"], summary,
  description: "Instance operator session or explicit instance_ai permission on an operator-created key. Keys are never returned, only their final four characters. Every saved provider must pass its connection test. Presets use their catalog URL; changing a saved target requires a new key. Each outbound request uses the server AI_ALLOWED_PRIVATE_TARGETS policy. Order starts at 1; the first provider is Main. Generation tries each provider on outage, timeout, rate limit, no credits, invalid key/model or empty response. Request validation errors stop the chain. answering_now marks the most recent successful generation, never a connection test.",
  ...(row ? { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] } : {}),
  ...(schema ? { requestBody: { required: true, content: { "application/json": { schema } } } } : {}),
  responses: { "200": { description: "Result", content: { "application/json": { schema: { type: "object", properties: { data: result, error: { type: "null" } } } } } }, "201": { description: "Provider connected", content: { "application/json": { schema: { type: "object", properties: { data: providerPublicSchema, error: { type: "null" } } } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { description: "Provider not found in this scope" }, "409": { description: "The list changed; reload and retry" }, "422": { description: "Invalid input or connection test failed; nothing saved" }, "429": { description: "Too many provider requests" } },
});

const channelIdParameter = { name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const insightErrors = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "402": { $ref: "#/components/responses/ProRequired" },
  "404": { $ref: "#/components/responses/NotFound" },
  "422": { description: "The channel's platform has no insights connector (error.code insights_unsupported), or the request body is invalid (validation_error)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
};
const insightStatusMeta = {
  type: "object", required: ["source", "transport", "lastSuccessfulSyncAt", "nextRetryAt"], properties: {
    source: { type: "string", example: "meta_instagram" },
    transport: { type: ["string", "null"], description: "Login whose credential is used for collection, when known." },
    lastSuccessfulSyncAt: { type: ["string", "null"], format: "date-time" },
    nextRetryAt: { type: ["string", "null"], format: "date-time", description: "Earliest next collection while backoff, quota or refresh cooldown applies." },
  },
};
const insightStatusResponse = (description: string, meta: object = insightStatusMeta) => ({
  description, content: { "application/json": { schema: { type: "object", required: ["data", "error", "meta"], properties: {
    data: { $ref: "#/components/schemas/InsightStatus" }, error: { type: "null" }, meta,
  } } } },
});
const exampleStatus = { channelId: "00000000-0000-4000-8000-000000000001", platform: "instagram", source: "meta_instagram", collectionMode: "on", displayStatus: "connected", state: "ready", transport: "facebook", credentialRevision: "3f1c…", requiredPermissions: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"], missingPermissions: [], checkedAt: "2026-11-07T05:00:00.000Z", lastAttemptAt: "2026-11-07T05:00:00.000Z", lastSuccessfulSyncAt: "2026-11-07T05:00:00.000Z", nextRetryAt: null, reason: "none", stale: false };
const exampleReach = { key: "reach", label: "Reach", level: "account", unit: "count", period: "day", grain: "day", aggregation: "unique_range", additive: false, definitionVersion: "instagram-reach-v1", coverageBasis: "provider_end_time; first interval boundary unconfirmed", cardOrder: 2, chartable: true, active: true, reason: null };
const exampleReport = (status: object, series: object[], value: string | null, reason: string | null) => ({
  data: { catalog: [exampleReach], series, summary: [{ metricKey: "reach", aggregation: "unique_range", value, complete: value !== null, comparisonPercent: null, reason }],
    coverage: { from: "2026-11-01T07:00:00.000Z", toExclusive: "2026-11-08T08:00:00.000Z", complete: value !== null, boundaryBasis: value === null ? null : "request_window" }, status },
  error: null,
  meta: { source: "meta_instagram", transport: "facebook", lastSuccessfulSyncAt: "2026-11-07T05:00:00.000Z", nextRetryAt: null, apiVersion: series.length ? "v26.0" : null, coverage: { from: "2026-11-01", toExclusive: "2026-11-08", complete: value !== null, boundaryBasis: value === null ? null : "request_window" } },
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
          autoStoryMode: { type: ["string", "null"], enum: ["card", "media", null], description: "Per-post Story mode; null inherits the channel default. card generates a branded card with a video frame; media uses the first asset (an Instagram video over 60 s is published as consecutive Stories of up to 60 s; Facebook video up to 120 s), falling back to card when limits are not met. Does not enable auto-Story." },
          articleUrl: { type: ["string", "null"], format: "uri", description: "LinkedIn article source URL (http/https, no credentials). When set, publishes as article; title required (max 200), description optional, mediaUrl is an optional thumbnail (0–1 image)." },
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
              lastError: { type: ["string", "null"], description: "Redacted provider error, including missing permission/scope, quota or payment/credits required. Permission and payment failures do not mark the channel needs_reauth. A sending/unknown outcome must be reconciled before publishing again." },
              platformPostId: { type: ["string", "null"] },
              updatedAt: { type: "string", format: "date-time" },
              firstComment: {
                type: "object",
                description: "Existing outbound ledger status takes precedence. Without a row, eligibility is evaluated NOW, not recorded at publish time: awaiting_publish unless sent, then no_text, unlicensed, unsupported_platform, private_post in that order. A sent, eligible delivery awaiting its comment worker has not_attempted with no reason.",
                required: ["status", "commentId", "attempts", "lastError"],
                properties: {
                  status: { type: "string", enum: ["pending", "sending", "sent", "failed", "held", "expired", "unknown", "not_attempted"] },
                  reason: { type: "string", enum: ["no_text", "unlicensed", "unsupported_platform", "private_post", "awaiting_publish"], description: "Only present for not_attempted when a reason applies; based on current request text, channel default, license, provider support and post privacy (private_post: a private YouTube video cannot take comments)." },
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
          default_auto_story: { type: "boolean" },
          default_auto_story_mode: { type: "string", enum: ["card", "media"], default: "card" },
          publish_target: { type: ["string", "null"], description: "Telegram only: channel @username or chat id that posts are published to. Null = not set (inbox only)." },
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
          video_carousel: { type: "string", enum: ["unknown", "unavailable", "available"], description: "Facebook video carousel permission, checked on connect/reconnect/managed sync. Only available enables video; unknown requires connection with a User/System User token to verify Page tasks." },
          capabilities: { type: "array", items: { type: "string", enum: ["publish", "comment_reply", "dm", "poll_comments", "receive_webhooks", "enumerate_subaccounts", "video_carousel", "insights"] }, description: "Computed capabilities for this channel. insights means the platform supports account Insights; current access is reported by GET /channels/{channelId}/insights." },
          missing_publish_scopes: { type: "array", items: { type: "string" }, description: "Known missing publishing permissions; reconnect the channel to grant them. Empty when scopes are unknown or sufficient." },
          can_publish: { type: "boolean", description: "Whether this channel can publish posts (true when capabilities include 'publish'). False for inbox-only channels such as Telegram." },
          created_at: { type: "string", format: "date-time" },
        },
      },
      InsightDecimal: {
        type: ["string", "null"], pattern: "^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$", example: "9007199254740993",
        description: "Exact non-negative decimal string, never a JSON number: no exponent, no rounding. \"0\" is an observed zero; null means no data.",
      },
      InsightStatus: {
        type: "object",
        description: "Locally stored collection status. Reading it never contacts the provider.",
        required: ["channelId", "platform", "source", "collectionMode", "displayStatus", "state", "transport", "credentialRevision", "requiredPermissions", "missingPermissions", "checkedAt", "lastAttemptAt", "lastSuccessfulSyncAt", "nextRetryAt", "reason", "stale"],
        properties: {
          channelId: { type: "string", format: "uuid" },
          platform: { type: "string" },
          source: { type: "string", example: "meta_instagram" },
          collectionMode: { type: "string", enum: ["off", "on"] },
          displayStatus: { type: "string", enum: ["off", "checking", "additional_access_required", "connected"] },
          state: { type: "string", enum: ["unknown", "ready", "missing_permission", "needs_reauth", "unsupported"], description: "Access state of the current credential." },
          transport: { type: ["string", "null"] },
          credentialRevision: { type: ["string", "null"], description: "Opaque version of the credential the access state belongs to." },
          requiredPermissions: { type: "array", items: { type: "string" } },
          missingPermissions: { type: "array", items: { type: "string" }, description: "Only permissions proven missing for the current credential." },
          checkedAt: { type: ["string", "null"], format: "date-time" },
          lastAttemptAt: { type: ["string", "null"], format: "date-time" },
          lastSuccessfulSyncAt: { type: ["string", "null"], format: "date-time" },
          nextRetryAt: { type: ["string", "null"], format: "date-time" },
          reason: { type: "string", enum: ["none", "first_sync", "provider_unavailable", "rate_limited", "token_required", "permission_required", "channel_paused", "collection_off", "worker_delayed"] },
          stale: { type: "boolean", description: "No successful collection in the last 48 hours." },
        },
      },
      InsightMetric: {
        type: "object",
        description: "Catalog entry of the channel's platform. Inactive entries (active=false) have no collected data and give the reason.",
        properties: {
          key: { type: "string", maxLength: 128 }, label: { type: "string" },
          level: { type: "string", enum: ["account"] },
          unit: { type: "string", enum: ["count", "percent", "milliseconds"] },
          period: { type: "string", enum: ["day", "lifetime"] },
          grain: { type: "string", enum: ["day", "range", "snapshot"] },
          aggregation: { type: "string", enum: ["sum", "unique_range", "latest_snapshot"], description: "unique_range values are never added across days or channels." },
          additive: { type: "boolean" }, definitionVersion: { type: "string" }, coverageBasis: { type: "string" },
          cardOrder: { type: ["integer", "null"] }, chartable: { type: "boolean" },
          active: { type: "boolean" }, reason: { type: ["string", "null"] },
        },
      },
      InsightObservation: {
        type: "object",
        description: "One stored daily value. Window instants keep the provider's day boundaries; providerDay is the provider's calendar day.",
        properties: {
          platform: { type: "string" }, metricKey: { type: "string" }, level: { type: "string", enum: ["account"] }, subjectKey: { type: "string" },
          grain: { type: "string", enum: ["day"] }, period: { type: "string", enum: ["day", "lifetime"] },
          metricType: { type: "string", enum: ["time_series", "total_value", "profile_field", "media_lifetime"] },
          windowStart: { type: "string", format: "date-time" }, windowEnd: { type: "string", format: "date-time" },
          snapshotDay: { type: "string", format: "date" }, providerDay: { type: ["string", "null"], format: "date", description: "The provider's calendar day covered by this value. Instagram uses its Pacific reporting day (America/Los_Angeles), which can appear one calendar day earlier than the same value's date in the Instagram app; reported values can also differ slightly from the app." },
          fetchedAt: { type: "string", format: "date-time" }, boundaryBasis: { type: "string" },
          value: { $ref: "#/components/schemas/InsightDecimal" },
          state: { type: "string", enum: ["available", "not_available", "insufficient_audience", "unsupported"] },
          dimensions: { type: "object", additionalProperties: { type: "string" } }, queryParams: { type: "object", additionalProperties: { type: "string" } },
          transport: { type: "string" }, apiVersion: { type: "string" }, definitionVersion: { type: "string" }, coverageBasis: { type: "string" },
          stale: { type: "boolean", description: "Fetched more than 48 hours ago." },
          provisional: { type: "boolean", description: "Ends within the last 48 hours; the provider can still revise it." },
          partial: { type: "boolean", description: "The provider sent only this day's end time, so windowStart is estimated. The value is shown but never added into a total." },
        },
      },
      AccountReport: {
        type: "object",
        required: ["catalog", "series", "summary", "coverage", "status"],
        properties: {
          catalog: { type: "array", items: { $ref: "#/components/schemas/InsightMetric" } },
          series: { type: "array", items: { $ref: "#/components/schemas/InsightObservation" }, description: "Empty when nothing is stored; missing days are absent, not zero." },
          summary: { type: "array", items: { type: "object", required: ["metricKey", "aggregation", "value", "complete", "comparisonPercent", "reason"], properties: {
            metricKey: { type: "string" },
            aggregation: { type: "string", enum: ["sum", "unique_range", "latest_snapshot"] },
            value: { $ref: "#/components/schemas/InsightDecimal" },
            complete: { type: "boolean", description: "A consistent definition covers every day, or an exact stored range observation supplies the unique total." },
            comparisonPercent: { type: ["string", "null"], pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$", description: "Change against the previous equal range, only when both ranges are complete and the previous value is not zero." },
            reason: { type: ["string", "null"], description: "Why the value is null or incomplete, e.g. incomplete_coverage or unique_range_unavailable." },
          } } },
          coverage: { type: "object", properties: { from: { type: "string", format: "date-time" }, toExclusive: { type: "string", format: "date-time" }, complete: { type: "boolean" }, boundaryBasis: { type: ["string", "null"] } } },
          status: { $ref: "#/components/schemas/InsightStatus" },
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
          failure_reason: {
            type: "string",
            nullable: true,
            description:
              "Why an outbound message ended `failed` and will not be retried: the platform's refusal (e.g. outside the allowed messaging window) or the error from the last send attempt. Secrets redacted, at most 500 characters. null for every other status and for messages that failed before this field existed.",
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
      AiProviderId: { type: "string", enum: ["openai", "anthropic", "openrouter", "groq", "custom"] },
      AiErrorCode: { type: "string", enum: ["invalid_key", "model_not_found", "rate_limited", "no_credits", "timeout", "unreachable", "blocked_target", "no_models_endpoint", "bad_response"] },
      AiModel: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, name: { type: "string" }, context: { type: "integer", description: "Context window in tokens" }, price_in: { type: "number", description: "USD per 1M input tokens (OpenRouter only)" }, price_out: { type: "number" } },
      },
      AiSettings: {
        type: "object",
        properties: {
          configured: { type: "boolean" },
          provider: { $ref: "#/components/schemas/AiProviderId" },
          base_url: { type: "string" },
          model: { type: "string" },
          api_key: { type: "object", properties: { set: { type: "boolean" }, source: { type: "string", enum: ["db", "env", "unset"] }, hint: { type: "string", nullable: true } } },
          sources: { type: "object", additionalProperties: { type: "string" } },
          fallbacks: { type: "object", properties: { count: { type: "integer" } } },
          providers: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, base_url: { type: "string", nullable: true }, models_need_key: { type: "boolean" }, key_url: { type: "string" } } } },
        },
      },
      AiSettingsUpdate: {
        type: "object",
        required: ["provider", "model"],
        properties: {
          provider: { $ref: "#/components/schemas/AiProviderId" },
          model: { type: "string", maxLength: 200, description: "Any model id the provider accepts; it does not have to be in the list." },
          api_key: { type: "string", description: "Required for a first save and whenever the provider or Base URL host changes." },
          base_url: { type: "string", nullable: true, description: "Only for `custom` (http/https, no credentials/query)." },
          verify: { type: "boolean", enum: [true], default: true },
        },
      },
      AiTestResult: {
        type: "object",
        properties: {
          ok: { type: "boolean" }, latency_ms: { type: "integer" }, model: { type: "string" },
          truncated: { type: "boolean", description: "The model used its whole token budget (reasoning) but the connection works." },
          error: { type: "object", properties: { code: { $ref: "#/components/schemas/AiErrorCode" }, http_status: { type: "integer" }, message: { type: "string" } } },
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
        description: "The content record requires content:read. Related posts, including their delivery status and scheduledFor, are included only when the caller also has posts:read.",
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["platform"], properties: {
          autoStoryMode: { type: ["string", "null"], enum: ["card", "media", null], description: "null inherits the channel default; applies only when auto-Story is enabled (PRO)." },
          platform: { type: "string" }, title: { type: "string", maxLength: 200 },
          articleUrl: { type: "string", format: "uri", description: "LinkedIn article source URL; http/https without credentials. Required to publish an article." },
          description: { type: "string" }, mediaUrl: { type: "string", format: "uri", description: "Optional article thumbnail; one image." },
        } } } } },
        description:
          "LinkedIn articles: set articleUrl and title (max 200); optional description and one thumbnail mediaUrl. " +
          "For Instagram and Facebook, mediaUrls with 2–10 URLs publishes every item in order as a carousel. Threads supports 2–20 images, videos or a mix. " +
          "Instagram accepts images and videos; Facebook video requires channel.video_carousel=available. The list takes precedence over mediaUrl/videoUrl. " +
          "Body accepts tiktokPublishMode/tiktokPrivacyLevel/tiktokDisableComment/tiktokDisableDuet/tiktokDisableStitch/" +
          "tiktokBrandContentToggle/tiktokBrandOrganicToggle/tiktokCoverTimestampMs (saved TikTok choices), and youtubePrivacy/youtubeTags/youtubeCategoryId/youtubeMadeForKids (YouTube publish " +
          "options), youtubeChapters ([{start: \"00:00\" or seconds, title}]; at least 3, first at 00:00, 10 s apart — appended to the " +
          "description at publish), youtubeLicense/youtubeEmbeddable/youtubePublicStatsViewable/youtubeNotifySubscribers/" +
          "youtubeDefaultLanguage/youtubeRecordingDate/youtubeLocalizations ({\"en\": {title, description}}, needs " +
          "youtubeDefaultLanguage) (YouTube film fields; age restriction can only be set in YouTube Studio) and aiDisclosure/aiDisclosureNote (declared AI-involvement level + optional in-content note; " +
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
        description: "Same body as create (all fields optional), including YouTube options and AI-disclosure fields. scheduledDate reschedules the linked pending delivery and publish job atomically. Returns 409 if the delivery is already publishing or no longer pending. Text, firstComment and media edits also update the pending payload atomically; sending deliveries return 409.",

        responses: { "200": { description: "Updated" }, "409": { description: "Delivery no longer pending" }, "422": { description: "Invalid schedule" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
      delete: {
        ...requiresScope("posts:write"),
        tags: ["Publishing"],
        summary: "Delete a post",
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/deliveries/{deliveryId}/cancel": {
      post: {
        ...requiresScope("posts:write"), tags: ["Publishing"], summary: "Cancel a pending delivery",
        description: "Cancels scheduled or held deliveries and returns linked posts to planned with deliveryId cleared, so they can be published again.",
        parameters: [{ name: "deliveryId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "204": { description: "Canceled" }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { description: "Delivery not found" }, "409": { description: "No longer pending" } },
      },
    },
    "/deliveries/{deliveryId}/publish-now": {
      post: {
        ...requiresScope("posts:write"), tags: ["Publishing"], summary: "Publish a pending delivery now",
        description: "Reschedules scheduled or held deliveries to now through the existing publish job. Repeated requests retain one job. TikTok send-time confirmation still applies; awaiting confirmation returns 409 and requires the Queue confirmation screen.",
        parameters: [{ name: "deliveryId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Rescheduled delivery in data" }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { description: "Delivery not found" }, "409": { description: "Already publishing, no longer pending, or confirmation required" } },
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
    "/posts/{postId}/platform": {
      ...Object.fromEntries((["get", "delete"] as const).map((method) => [method, {
        ...requiresScope(method === "get" ? "posts:read" : "posts:write"), tags: ["Publishing"],
        summary: method === "get" ? "Read a sent X post on the platform" : "Delete a sent X post from the platform",
        description: "X only. Keeps local history. GET returns data.exists, providerStatus (200 or 404), platformPostId. DELETE requires X acknowledgement and returns data.deleted=true; follow with GET to confirm providerStatus=404.",
        parameters: [{ name: "postId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Platform result in data" }, "401": { description: "Authentication required" }, "403": { description: "Missing scope" }, "404": { description: "Published post not found" }, "409": { description: "Requires a sent X post" }, "502": { description: "X operation failed" } },
      }])),
    },
    "/posts/{postId}/publish": {
      post: {
        ...requiresScope("posts:write"),
        tags: ["Publishing"],
        summary: "Publish or schedule a post through the delivery engine",
        description: "Returns the existing delivery + post envelope immediately. For Instagram/Facebook, 2–10 mediaUrls select carousel automatically (or set format=carousel explicitly). Threads accepts 2–20 images/videos, including mixed carousels. Threads publication remains processing while containers prepare; retries resume saved stages. An uncertain finalization is checked without another publish attempt. Facebook carousels require ready media. Video requires channel.video_carousel=available (pages_manage_ads for this Page and ADVERTISE task); missing access or still-ingesting items return 422. Wait for GET /media/{id} to report ready before retrying. Unregistered URL media are ingested in the background. The scheduled delivery waits without consuming publish attempts, never sends before its scheduled time, and fails with the media error if ingestion fails. Registered media are reused.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["channelId"], properties: { channelId: { type: "string", format: "uuid" }, when: { type: "string", example: "now" }, format: { type: "string", description: "Optional override. Meta story accepts one image or video. An Instagram Story video over 60 s is split into consecutive Stories of up to 60 s (see storySegments). LinkedIn article requires saved articleUrl and title; thumbnail optional." } } } } } },
        responses: { "200": { description: "Delivery created + linked. data.storySegments: number of Instagram Stories a Story video (format story, or auto-Story in media mode) is published as — over 60 s it is split into consecutive clips of up to 60 s; null when no Instagram Story video is involved or its length is not known yet.", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { delivery: { type: "object" }, post: { type: "object" }, storySegments: { type: ["integer", "null"], minimum: 1 } } }, error: { type: "null" } } } } } }, "404": { description: "Not found" }, "409": { description: "Already published" }, "422": { description: "Validation error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/media": {
      get: {
        ...requiresScope("media:write"), tags: ["Publishing"], summary: "List the 100 most recent ready media files",
        description: "Returns canonical workspace media (id, url, kind), newest first. Ingesting files and aliases are omitted.",
        responses: { "200": { description: "Ready media library", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { type: "object", properties: { id: { type: "string", format: "uuid" }, url: { type: "string", format: "uri" }, kind: { type: "string", enum: ["image", "video"] } } } }, error: { type: "null" } } } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { description: "Missing media:write scope" } },
      },
      post: {
        ...requiresScope("media:write"),
        tags: ["Publishing"],
        summary: "Upload a file or register a media URL into content-addressed storage",
        description: "Binary image/*, video/* or application/octet-stream bodies upload a file and return ready metadata with 201. Remote URLs return 202 immediately. Poll GET /media/{id} until status is ready or failed; error explains failures. Publish only ready media. Matching sha256+mime+kind objects already in storage return 201 without downloading. Compose and editorial post publishing also queue remote ingestion; their delivery remains scheduled until media is ready.",
        parameters: [{ name: "wait", in: "query", schema: { type: "boolean", default: false }, description: "Wait up to 60 seconds for a worker: 201 when ready, 400 when failed, otherwise 202 with the same polling handle." }],
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } }, "image/*": { schema: { type: "string", format: "binary" } }, "video/*": { schema: { type: "string", format: "binary" } }, "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, mime: { type: "string" }, kind: { type: "string", enum: ["image", "video"] }, size: { type: "integer" }, durationSec: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } } } } } },
        responses: { "202": { description: "Accepted: data.id is the polling handle, data.status is ingesting; media metadata becomes available when ready" }, "201": { description: "Media registered" }, "400": { description: "Media ingest error" }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/media/{id}": {
      get: {
        ...requiresScope("media:write"), tags: ["Publishing"], summary: "Read media ingestion status and metadata",
        description: "Returns {data,error}. data.status is ingesting, ready or failed; data.error contains the failure reason or null. Once ready, data contains url, checksum, kind, mime, size and durationSec. Pending metadata must not be used for publishing.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Workspace-scoped media status and metadata" }, "404": { description: "Media not found" }, "401": { $ref: "#/components/responses/Unauthorized" } },
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
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { publish_target: { type: ["string", "null"], description: "Telegram only: @username or chat id of the channel/group to publish to; null clears. 422 unless the bot is an administrator with permission to post (channel) or may write (group)." }, default_auto_story: { type: "boolean", description: "Requires auto_story (PRO)." }, default_auto_story_mode: { type: "string", enum: ["card", "media"], description: "Requires auto_story (PRO); does not change the toggle." }, display_name: { type: "string" }, status: { type: "string", enum: ["active", "paused"] } } } } } },
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
        description: "Removes the channel from connected accounts while retaining its history and sequence enrollments.",
        responses: {
          "204": { description: "Disconnected" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
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
    "/channels/{channelId}/insights": {
      get: {
        ...requiresScope("stats:read"),
        tags: ["Insights"],
        summary: "Read the account Insights collection status",
        description: "Reads locally stored status only; never contacts the provider. Requires the PRO insights feature.",
        parameters: [channelIdParameter],
        responses: {
          "200": { ...insightStatusResponse("Collection status"), content: { "application/json": { ...insightStatusResponse("").content["application/json"], examples: {
            connected: { value: { data: exampleStatus, error: null, meta: { source: "meta_instagram", transport: "facebook", lastSuccessfulSyncAt: exampleStatus.lastSuccessfulSyncAt, nextRetryAt: null } } },
            permission: { value: { data: { ...exampleStatus, displayStatus: "additional_access_required", state: "missing_permission", missingPermissions: ["instagram_manage_insights"], reason: "permission_required" }, error: null, meta: { source: "meta_instagram", transport: "facebook", lastSuccessfulSyncAt: null, nextRetryAt: null } } },
          } } } },
          ...insightErrors,
        },
      },
      patch: {
        ...requiresScope("channels:write"),
        tags: ["Insights"],
        summary: "Switch account Insights collection on or off",
        description: "on queues a background access check and first collection, returning checking until it completes. Granting additional access is a dashboard-only flow; the response gives a hint (meta.hint), never an authorization link. off stops collection and keeps stored data for its retention period.",
        parameters: [channelIdParameter],
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", additionalProperties: false, required: ["collectionMode"], properties: { collectionMode: { type: "string", enum: ["on", "off"] } },
        } } } },
        responses: {
          "200": insightStatusResponse("Updated status", { ...insightStatusMeta, properties: { ...insightStatusMeta.properties, hint: { type: "string", description: "Present after switching on." } } }),
          ...insightErrors,
        },
      },
    },
    "/channels/{channelId}/insights/account": {
      get: {
        ...requiresScope("stats:read"),
        tags: ["Insights"],
        summary: "Read stored account metrics for a range of provider days",
        description: "Reads local data only; never contacts the provider. from and to are calendar days in the provider's day basis; to is exclusive and the range covers 1 to 90 days. Values are exact decimal strings: \"0\" is an observed zero, null or a missing day means no data. reach-like unique_range metrics use an exact stored [from,to) observation; otherwise the value is null with unique_range_unavailable. The worker collects the current 7/30-day windows; other API ranges require an exact stored observation. Daily reach is never added across days. The provider can revise the last 48 hours (provisional). Account metrics only.",
        parameters: [
          channelIdParameter,
          { name: "from", in: "query", required: true, schema: { type: "string", format: "date" }, example: "2026-11-01" },
          { name: "to", in: "query", required: true, schema: { type: "string", format: "date" }, example: "2026-11-08", description: "Exclusive end day." },
          { name: "metrics", in: "query", required: false, schema: { type: "string" }, example: "reach", description: "Comma-separated, up to 16 distinct account metric keys from the channel catalog (128 characters each). Defaults to every account metric. The whole query string is limited to 2048 characters." },
        ],
        responses: {
          "200": {
            description: "Account report; meta.coverage repeats the requested provider days",
            content: { "application/json": {
              schema: { type: "object", required: ["data", "error", "meta"], properties: {
                data: { $ref: "#/components/schemas/AccountReport" }, error: { type: "null" },
                meta: { type: "object", properties: { ...insightStatusMeta.properties,
                  apiVersion: { type: ["string", "null"], description: "Provider API version of the most recently fetched value in the series." },
                  coverage: { type: "object", properties: { from: { type: "string", format: "date" }, toExclusive: { type: "string", format: "date" }, complete: { type: "boolean" }, boundaryBasis: { type: ["string", "null"] } } },
                } },
              } },
              examples: {
                empty: { summary: "Collection on, no stored data yet", value: exampleReport({ ...exampleStatus, displayStatus: "checking", state: "unknown", lastSuccessfulSyncAt: null, reason: "first_sync" }, [], null, "unique_range_unavailable") },
                permission: { summary: "Additional access required", value: exampleReport({ ...exampleStatus, displayStatus: "additional_access_required", state: "missing_permission", missingPermissions: ["instagram_manage_insights"], reason: "permission_required" }, [], null, "unique_range_unavailable") },
                rangeAvailable: { summary: "Exact stored range total, including an observed zero", value: exampleReport(exampleStatus, [], "0", null) },
                rangeUnavailable: { summary: "Daily values stored; no unique value for the whole range", value: exampleReport(exampleStatus, [{ platform: "instagram", metricKey: "reach", level: "account", subjectKey: "17841400000000000", grain: "day", period: "day", metricType: "time_series", windowStart: "2026-11-01T07:00:00.000Z", windowEnd: "2026-11-02T08:00:00.000Z", snapshotDay: "2026-11-01", providerDay: "2026-11-01", fetchedAt: "2026-11-04T05:00:00.000Z", boundaryBasis: "provider_end_time", value: "0", state: "available", dimensions: {}, queryParams: {}, transport: "facebook", apiVersion: "v26.0", definitionVersion: "instagram-reach-v1", coverageBasis: "provider_end_time; first interval boundary unconfirmed", stale: false, provisional: false, partial: false }], null, "unique_range_unavailable") },
              },
            } },
          },
          "400": { description: "Invalid range, date, metric or query parameter", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          ...insightErrors,
        },
      },
    },
    "/channels/{channelId}/insights/refresh": {
      post: {
        ...requiresScope("channels:write"),
        tags: ["Insights"],
        summary: "Queue an account Insights collection run",
        description: "Queues a deduplicated background run; never publishes or sends anything. Refresh is limited to once per 15 minutes per channel and does not reset provider backoff or quota. queued=false when collection is off or access must be granted first.",
        parameters: [channelIdParameter],
        responses: {
          "202": { description: "Accepted", content: { "application/json": { schema: { type: "object", required: ["data", "error"], properties: {
            data: { type: "object", required: ["status", "queued"], properties: { status: { $ref: "#/components/schemas/InsightStatus" }, queued: { type: "boolean" } } }, error: { type: "null" },
          } } } } },
          "429": {
            description: "Cooldown, provider backoff or quota is active; error.details gives { retry_after (seconds), next_retry_at }",
            headers: { "Retry-After": { description: "Seconds until the next refresh can be queued", schema: { type: "integer", minimum: 1 } } },
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { data: null, error: { code: "rate_limited", message: "Insights refresh is not available yet", details: { retry_after: 840, next_retry_at: "2026-11-08T12:15:00.000Z" } } } } },
          },
          ...insightErrors,
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
    "/messages/{messageId}": {
      parameters: [{ name: "messageId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        ...requiresScope("conversations:read"),
        tags: ["Conversations"],
        summary: "Get a message by id (the content behind a message.received event)",
        responses: {
          "200": { description: "Message", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Message" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/comments/{commentId}": {
      parameters: [{ name: "commentId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      get: {
        ...requiresScope("conversations:read"),
        tags: ["Conversations"],
        summary: "Get a comment by id (the content behind a comment.received event)",
        responses: {
          "200": { description: "Comment: id, conversation_id, channel_id, post_id, post_url, platform_comment_id, author_name, comment_text, created_at" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
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
        description: "Comment threads queue a public reply to the latest inbound comment. Other threads require a channel with direct messaging. Needs reply is cleared only after successful delivery, provided no newer activity arrived.",
        parameters: [
          { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 200 }, description: "Repeat-safe send: the same key sends at most once (≤200 chars)" },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 2000 } } } } } },
        responses: {
          "201": { description: "Queued for sending" },
          "400": { description: "No platform identity / over-long Idempotency-Key" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "Validation error, `reply_unavailable` for an unsupported reply or missing parent comment, or `messaging_window_closed`: a Facebook/Instagram DM more than 24h after the customer's last message (Meta only allows the HUMAN_AGENT tag after the operator sets `META_HUMAN_AGENT_APPROVED=true`)" },
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
    "/settings/ai/providers": {
      get: providerEndpoint("List AI providers in replacement order", false),
      post: providerEndpoint("Connect a tested provider at the end", true, { ...providerInputSchema, required: ["provider", "model", "api_key"] }, providerPublicSchema),
      put: providerEndpoint("Replace the entire list atomically after testing all entries", true, { type: "object", additionalProperties: false, required: ["providers"], properties: { providers: { type: "array", maxItems: 1000, items: { ...providerInputSchema, properties: { ...providerFields, id: { type: "string", format: "uuid" } } } } } }),
    },
    "/settings/ai/providers/{id}": {
      patch: providerEndpoint("Edit and test a provider", true, providerInputSchema, providerPublicSchema, true),
      delete: providerEndpoint("Remove a provider and close its position", true, undefined, undefined, true),
    },
    "/settings/ai/providers/reorder": { put: providerEndpoint("Apply a complete provider ID permutation atomically", true, { type: "object", required: ["ids"], additionalProperties: false, properties: { ids: { type: "array", maxItems: 1000, uniqueItems: true, items: { type: "string", format: "uuid" } } } }) },
    "/settings/ai/providers/test": { post: providerEndpoint("Test candidate or saved provider without saving", true, { ...providerInputSchema, properties: { ...providerFields, id: { type: "string", format: "uuid" } } }, { $ref: "#/components/schemas/AiTestResult" }) },
    "/settings/ai/providers/models": { post: providerEndpoint("List models for candidate or saved provider", true, { ...providerInputSchema, properties: { ...providerFields, id: { type: "string", format: "uuid" }, refresh: { type: "boolean" }, all: { type: "boolean" } } }, { type: "object", properties: { models: { type: "array", items: { $ref: "#/components/schemas/AiModel" } }, fetched_at: { type: "string", format: "date-time" }, cached: { type: "boolean" }, filtered_out: { type: "integer" } } }) },
    "/settings/ai/providers/{id}/test": { post: providerEndpoint("Test a saved provider again", true, undefined, { $ref: "#/components/schemas/AiTestResult" }, true) },
    "/settings/publishing-oauth": {
      get: {
        ...requiresScope("instance_config:read"), tags: ["Workspace"], summary: "Get publishing OAuth setting sources",
        description: "Operator session or explicit instance_config:read on an operator-created API key. Returns config status fields (key, group, label, secret, source, preview); secret previews are masked.",
        responses: { "200": publishingOAuthResponse },
      },
      put: {
        ...requiresScope("instance_config:write"), tags: ["Workspace"], summary: "Set publishing OAuth credentials",
        description: "Operator session or explicit instance_config:write on an operator-created API key. Omitted fields stay unchanged. Settings override env; local cache is invalidated immediately and workers refresh within 30 seconds. Clear stored fields through Settings → Integrations to restore env fallback.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: Object.fromEntries(PUBLISHING_OAUTH_KEYS.map((key) => [key, { type: "string", minLength: 1, maxLength: 4096, writeOnly: true }])) } } } },
        responses: { "200": publishingOAuthResponse, "422": { description: "Unknown fields or invalid values." } },
      },
    },
    "/settings/ai": {
      get: {
        ...requiresScope("instance_ai:read"),
        tags: ["Instance settings"],
        summary: "Get Main AI provider settings (never the API key)",
        description: "Requires an API key created by the instance operator with the instance_ai permissions (an empty permission list never grants them), or an operator session. The key is bound to its creator: it stops working when they are no longer an operator. `providers` is the catalog to pick from; `api_key.hint` is the last 4 characters of a key of 20+ characters, otherwise null.",
        responses: {
          "200": { description: "Effective AI settings", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/AiSettings" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
      put: {
        ...requiresScope("instance_ai:write"),
        tags: ["Instance settings"],
        summary: "Choose the AI provider and model",
        description: "Typical agent flow: GET this → POST /settings/ai/models with the key → PUT here → GET /license shows `ai_configured: true`. Edits update Main and preserve every backup and its ID. A minimal chat request is always sent first; `verify: false` is rejected and nothing is saved if the test fails (422 with the error code). `base_url` is allowed only for `custom`. When the provider or the host of the Base URL changes, `api_key` is required (422 `API_KEY_REQUIRED`): the saved key is never sent to a different provider or host. Private/loopback targets are blocked unless the server lists them in AI_ALLOWED_PRIVATE_TARGETS (`blocked_target`).",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AiSettingsUpdate" } } } },
        responses: {
          "200": { description: "Saved; the new effective settings", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/AiSettings" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Validation failed (`API_KEY_REQUIRED`, `BASE_URL_NOT_ALLOWED`, `BASE_URL_REQUIRED`, `INVALID_BASE_URL`, `INVALID_MODEL`) or the connection test failed (`error.code` is an AiErrorCode, `error.details.http_status` the provider's status). Provider response bodies are never included." },
        },
      },
      delete: {
        ...requiresScope("instance_ai:write"),
        tags: ["Instance settings"],
        summary: "Remove Main and promote the next provider, or use environment defaults",
        responses: {
          "200": { description: "Effective settings after removal", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/AiSettings" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/settings/ai/models": {
      post: {
        ...requiresScope("instance_ai:read"),
        tags: ["Instance settings"],
        summary: "List the provider's models (cached 24 h)",
        description: "POST so the candidate `api_key` never appears in a URL. Every field is optional: omitted ones come from the saved config, but the saved key is used only for the saved provider and host. Embedding, speech, image and moderation models are hidden unless `all` is true; `refresh` bypasses the cache. Limit: 10 requests per minute.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { provider: { $ref: "#/components/schemas/AiProviderId" }, api_key: { type: "string" }, base_url: { type: "string", nullable: true }, refresh: { type: "boolean", default: false }, all: { type: "boolean", default: false } } } } } },
        responses: {
          "200": { description: "Models", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { models: { type: "array", items: { $ref: "#/components/schemas/AiModel" } }, fetched_at: { type: "string", format: "date-time" }, cached: { type: "boolean" }, filtered_out: { type: "integer" } } }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "The list could not be fetched (`error.code` is an AiErrorCode) or the candidate is invalid" },
          "429": { description: "Too many requests" },
        },
      },
    },
    "/settings/ai/test": {
      post: {
        ...requiresScope("instance_ai:write"),
        tags: ["Instance settings"],
        summary: "Send one tiny chat request to check provider, key and model",
        description: "Costs a few tokens. Needs `model` (or a saved one). A failed probe is a normal 200 response with `data.ok: false`. Limit: 5 requests per minute.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { provider: { $ref: "#/components/schemas/AiProviderId" }, api_key: { type: "string" }, base_url: { type: "string", nullable: true }, model: { type: "string" } } } } } },
        responses: {
          "200": { description: "Probe result", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/AiTestResult" }, error: { type: "null" } } } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "Invalid candidate, or `API_KEY_REQUIRED` when probing another provider/host without a key" },
          "429": { description: "Too many requests" },
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
        description: "Subscribe a URL to events. Returns the HMAC signing secret ONCE. Requires a PRO license. contact.erased provides data.id, workspaceId and channels [{channelId, platform, platformSenderId}] captured before deletion; GET contact then returns 404. conversation.updated provides data.conversationId, contactId, channelId, workspaceId, updatedAt (UTC), previous and current states ({status: open|closed|snoozed, is_automation_paused, assigned_to}). State events include automatic reopening by an incoming message or comment, and exclude read receipts, unchanged values and message activity without a state change. Both types are selectable explicitly and included in wildcard subscriptions ([]). message.received and comment.received announce a message or comment from a contact (never our own sends or echoes) and carry identifiers only: data.id (also messageId or commentId), workspaceId, channelId, platform, conversationId, contactId, direction (inbound), createdAt, plus postId for comments. Read the content with GET /messages/{messageId} or GET /comments/{commentId}.",
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } }, "image/*": { schema: { type: "string", format: "binary" } }, "video/*": { schema: { type: "string", format: "binary" } }, "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, event_types: { type: "array", items: { type: "string" }, description: "Omit/empty for all events" }, headers: { type: "object", additionalProperties: { type: "string" }, description: "Custom HTTP headers merged into every delivery (e.g. an Authorization token). Encrypted at rest." }, extra_payload_fields: { type: "object", additionalProperties: true, description: "Extra top-level fields merged into every delivered body." } } } } } },
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
    { name: "Insights", description: "Account metrics collected from supported channels (PRO). Collection is opt-in per channel; every read uses locally stored data." },
    { name: "Webhooks", description: `Outbound event webhooks require PRO. Register a URL and retain the signing secret returned once on creation. An empty event_types array subscribes to every catalog event, including future additions.

### Envelope and delivery
The default JSON envelope is { id, type, created_at, data }. id is the event UUID for deduplication, type is the event name, created_at is the event timestamp in UTC, and data.id / data.type identify the subject. Post subjects use the editorial post ID from GET /posts/{id} (legacy deliveries without an editorial post use the delivery ID). Event-specific fields are inside data. Payload changes are additive; accept unknown fields. Custom extra_payload_fields can override envelope fields, so the following contract describes the default body.

POSTs use Content-Type: application/json, X-PostStack-Event and X-PostStack-Timestamp. Verify \`X-PostStack-Signature: t=<unix>,v1=<hmac>\` by computing HMAC-SHA256 in hexadecimal over timestamp.raw-body (the decimal timestamp, a literal dot, then the exact raw request bytes), using the endpoint secret. Compare in constant time before parsing JSON, check timestamp freshness (e.g. 300 seconds), and accept any matching v1 value during secret rotation. Do not reserialize JSON before verification.

A 2xx response acknowledges delivery. Non-2xx responses, network failures and the 10-second timeout retry with exponential backoff for up to 8 attempts total. The final failed attempt is retained as failed. Delivery is at least once: deduplicate by envelope id, acknowledge quickly, and process asynchronously. Ordering between events is not guaranteed; a retry signs with a new delivery timestamp but keeps the event id and created_at.

### Event data catalog
Every event includes data.id and data.type. Fields below are additional data fields; nullable results remain null until known.

| Event | Subject and data fields |
| --- | --- |
| \`post.published\` | post: workspaceId, channelId, platform, status=published, deliveryId, providerHandle (platform post ID), publishedAt (UTC), firstComment {status, commentId, attempts, lastError, reason?}. firstComment is a snapshot at emission; not_attempted without a reason means the comment is eligible and awaiting its worker. Skip reasons: no_text, unlicensed, unsupported_platform, private_post (private YouTube video). |
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
