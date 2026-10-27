# PostStack domain glossary

Use these terms in code, UI and discussions. English identifiers and the explanatory translations used in conversation refer to the same concepts; do not introduce alternative entity names. “Forbidden” below means forbidden **as a synonym for that row**, not forbidden as a distinct concept elsewhere.

The definitions are read from the linked implementation. Existing API/DB spellings are contracts, not instructions to rename code. Maintain this file during work (including `grill`): when a term is introduced or clarified, update its existing row or add one with implementation evidence here.

## Product and ownership

| Canonical term | One-sentence definition | Forbidden synonyms / confusion | Implementation evidence |
| --- | --- | --- | --- |
| PostStack | The self-hosted product combining publishing, inbox replies, automation and CRM in this repository. | ReplyStack as the current product name; ReelStack as this product. | [BRAND.name](../src/lib/brand.ts); [license product aliases](../src/lib/env.ts). |
| ReelStack | The external media producer whose signed completion webhook can register media in PostStack. | PostStack, ReplyStack, TakeOS or Reel Studio as names for this integration. | [integration route](../src/server/routes/integrations.ts): `/integrations/reelstack/webhook`; [registerKnownMedia](../src/lib/media/service.ts). |
| workspace | The tenant boundary that owns operational data and scopes API access. | brand, instance, user. | [schema](../src/db/schema.ts): `workspaces`, `workspace_id`. |
| instance operator | A user session allowed to administer shared instance credentials and licensing, selected by `INSTANCE_ADMIN_EMAILS` or the earliest existing user. | workspace owner, API key. | [operator policy](../src/lib/auth/instance-operator.ts). |
| user | A login identity that can belong to a workspace through workspace membership. | contact, subscriber, channel. | [schema](../src/db/schema.ts): `users`, `workspaceMembers`. |
| brand | A named grouping of channels within a workspace, identified by a workspace-local key. | workspace, connected social account, product-wide `BRAND`. | [schema](../src/db/schema.ts): `brands`, `channels.brand_key`; [createBrand](../src/lib/brands/service.ts). |
| profile | The existing editorial content field carrying the brand key used to resolve publishing channels. | social-account profile, workspace; a new `brandId` field replacing the existing contract. | [schema](../src/db/schema.ts): `content.profile`; [composeContent](../src/lib/content/compose.ts): `profile: input.brand.trim()`. |
| channel | A connected platform account used for the capabilities that account supports. | brand, workspace, account source, provider. | [schema](../src/db/schema.ts): `channels`; [channel capabilities](../src/lib/channels/capabilities.ts). |
| account source | A stored master Meta connection that enumerates and synchronizes derived channels. | channel, content source, media source; “managed connection” is the existing UI label, not another entity. | [schema](../src/db/schema.ts): `accountSources`, `channels.source_id`; [Sources UI](../src/server/ui/sections/sources.ts). |
| platform | The target service identifier, with explicit mappings between editorial, channel and provider representations. | provider, channel; treating `meta` as a stored Facebook/Instagram channel platform. | [platform enum](../src/db/schema.ts); [channelMatchesPlatform](../src/lib/channels/platform-match.ts); [providerIdForPlatform](../src/lib/providers/index.ts). |

## Provider boundaries

| Canonical term | One-sentence definition | Forbidden synonyms / confusion | Implementation evidence |
| --- | --- | --- | --- |
| SocialProvider | The platform adapter contract used by the inbox side for connection, messaging and related platform operations. | Publishing `Provider` as an interchangeable type; unqualified `getProvider` without its module context. | [base class](../src/lib/platforms/base.ts); [inbox registry](../src/lib/platforms/registry.ts). |
| Provider | The publishing adapter contract exposing formats, account health and publish operations. | `SocialProvider` as an interchangeable type; provider id as a channel id. | [interface](../src/lib/providers/types.ts); [publishing registry](../src/lib/providers/registry.ts). |
| EmailProvider | The SocialProvider extension that normalizes mailbox polling and email retrieval. | Publishing provider, generic webhook provider. | [EmailProvider and NormalizedEmail](../src/lib/platforms/email.ts); [extension guide](ADDING_A_MAILBOX_PROVIDER.md). |
| TokenData | The inbox-side token shape using fields such as `access_token` and `expires_at`. | `TokenSet` as the same serialized shape. | [TokenData](../src/lib/platforms/base.ts); [token conversion](../src/lib/providers/token-codec.ts). |
| TokenSet | The publishing-side token shape using fields such as `accessToken` and `expiresAt`. | `TokenData` as the same serialized shape. | [TokenSet](../src/lib/providers/types.ts); [token conversion](../src/lib/providers/token-codec.ts). |

## Inbox and automation

| Canonical term | One-sentence definition | Forbidden synonyms / confusion | Implementation evidence |
| --- | --- | --- | --- |
| contact | A workspace-owned CRM identity whose platform sender identities are linked through contact-channel records. | user, follower, channel; subscriber as a separate identity entity. | [schema](../src/db/schema.ts): `contacts`, `contactChannels`, `is_subscribed`. |
| tag | A workspace-owned contact label attached through the contact-tag relation. | hashtag, YouTube tag, message tag. | [schema](../src/db/schema.ts): `tags`, `contactTags`; [contact tagging](../src/lib/contacts/tags.ts). |
| conversation | An inbox thread grouped by channel, contact, thread type and thread reference. | individual message, editorial post, entire inbox. | [schema](../src/db/schema.ts): `conversations`, `thread_type`, `thread_ref`. |
| message | An inbound or outbound message record associated with a conversation. | editorial post, reaction, outbound delivery ledger entry. | [schema](../src/db/schema.ts): `messages`, `messageDirection`. |
| comment | A platform comment recorded with its platform post context and handled through comment conversations and automation. | DM, editorial `posts.id`, reaction. | [schema](../src/db/schema.ts): `commentLogs`, `conversationThreadType`; [comment worker](../src/lib/workers/incoming-comment-worker.ts). |
| message reaction | An emoji reaction to a DM, recorded separately from messages. | message, post reaction. | [schema](../src/db/schema.ts): `messageReactions`. |
| post reaction | A reaction to a platform post, recorded with inline reactor identity rather than automatically creating a contact. | comment, message reaction, contact. | [schema](../src/db/schema.ts): `postReactions`; [reaction worker](../src/lib/workers/incoming-post-reaction-worker.ts). |
| rule | An auto-reply rule matching a trigger and executing its configured response with priority and limits. | sequence, flow, broadcast; post-level `autoReply` configuration as the persisted rule itself. | [schema](../src/db/schema.ts): `autoReplyRules`; [executor](../src/lib/rules/executor.ts). |
| trigger | The event condition described by a rule's trigger type and configuration. | response, rule, outbound action. | [schema](../src/db/schema.ts): `trigger_type`, `trigger_config`; [matcher](../src/lib/rules/matcher.ts). |
| response | The behavior selected by a rule's response type and configuration. | trigger, HTTP response, approval. | [schema](../src/db/schema.ts): `response_type`, `response_config`; [response selection](../src/lib/rules/response.ts). |
| autoReply | The post-level automation configuration provisioned into a rule after publishing. | separate ReplyStack service, standalone rule id; `auto_reply` is the DB spelling of this field. | [postCreate](../src/lib/content/schemas.ts); [provisionAutoReply](../src/lib/autoreply/provision.ts); [schema](../src/db/schema.ts): `posts.auto_reply`. |
| cooldown | The minimum interval before the same rule may fire again for a contact. | send-count limit, sequence delay, channel rate limit. | [schema](../src/db/schema.ts): `cooldown_seconds`, `ruleCooldowns`; [rule limits](../src/lib/rules/limits.ts). |
| sequence | A reusable ordered drip-message definition with timed steps. | enrollment, rule, flow, broadcast. | [schema](../src/db/schema.ts): `sequences`; [sequence worker](../src/lib/workers/sequence-step-worker.ts). |
| enrollment | A contact's execution of a sequence on a channel using an immutable snapshot of its steps. | sequence definition, contact subscription, workspace membership. | [schema](../src/db/schema.ts): `sequenceEnrollments`, `steps_snapshot`; [enroll](../src/lib/sequences/enroll.ts). |
| approval | A proposed reply from a rule or AI draft awaiting a human decision before sending. | published-content approval, delivery receipt, automatic send. | [schema](../src/db/schema.ts): `pendingApprovals`, `approvalSource`; [ProposedContent](../src/lib/approvals/draft.ts). |
| AI draft | An AI-generated reply proposal routed to human approval or per-surface autosend according to the channel configuration. | AI rephrase, automatic editorial post, approval as a mandatory step for every draft. | [generateDraft](../src/lib/ai/draft.ts); [AI draft worker](../src/lib/workers/ai-draft-worker.ts). |
| AI rephrase | An AI rewrite of supplied response text that preserves its meaning and falls back to the original text on failure. | AI draft, new editorial content generation. | [rephrase](../src/lib/ai/rephrase.ts); [schema](../src/db/schema.ts): `aiGenerationKind`. |

## Publishing and delivery

| Canonical term | One-sentence definition | Forbidden synonyms / confusion | Implementation evidence |
| --- | --- | --- | --- |
| content | An editorial material containing shared title, script, assets and brand context for platform-specific posts. | individual post, delivery, `ProposedContent.content` message body. | [schema](../src/db/schema.ts): `content`; [composeContent](../src/lib/content/compose.ts). |
| post | An editorial publishing plan for one platform, optionally linked to shared content and an execution delivery. | content, message, platform post id, delivery itself. | [schema](../src/db/schema.ts): `posts`, `content_id`, `delivery_id`, `platform_post_id`. |
| delivery | The publishing execution ledger entry for a normalized publish request on a channel. | editorial post, reply send (`outboundDeliveries`), outbound webhook delivery. | [schema](../src/db/schema.ts): `deliveries`; [createDelivery](../src/lib/deliveries/service.ts). |
| outbound delivery | The durable ledger entry for one logical outgoing inbox send. | publishing `deliveries`, outbound webhook delivery, message record. | [schema](../src/db/schema.ts): `outboundDeliveries`, `delivery_key`; [send ledger](../src/lib/workers/delivery.ts). |
| media | A workspace-scoped registered image or video asset deduplicated by checksum. | platform post id, editorial content, caption. | [schema](../src/db/schema.ts): `media`; [media service](../src/lib/media/service.ts). |
| firstComment | An optional comment automatically posted after publication, overriding the channel default when explicitly set. | auto-reply to an incoming comment, description, DM. | [PublishRequest](../src/lib/providers/types.ts); [schema](../src/db/schema.ts): `posts.first_comment`; [postCreate](../src/lib/content/schemas.ts). |
| autoStory | The per-post option controlling automatic Story creation after publication, inheriting the channel default when unset. | incoming story reply/mention trigger, the main post, `autoReply`. | [PublishRequest](../src/lib/providers/types.ts); [schema](../src/db/schema.ts): `posts.auto_story`; [Story renderer](../src/lib/stories/renderer.ts). |
| aiDisclosure | The declared AI-content level resolved for publication from post, channel and brand defaults. | boolean “AI used”, AI draft, AI rephrase; `none` and unset as identical declarations. | [schema](../src/db/schema.ts): `aiDisclosureLevel`, `posts.ai_disclosure`; [resolveDisclosure](../src/lib/ai-disclosure/resolve.ts). |
| webhook event | A logged inbound platform event with a deduplication key and handling outcome. | internal event, outbound webhook delivery. | [schema](../src/db/schema.ts): `webhookEvents`; [inbound log](../src/lib/webhook-events/log.ts). |
| event | An internal workspace event that can feed realtime updates and outbound webhook dispatch. | raw inbound webhook event, webhook delivery. | [schema](../src/db/schema.ts): `events`; [event bus](../src/lib/events.ts). |
| webhook endpoint | A workspace's outbound event subscription with target URL, signing secret and selected event types. | incoming platform webhook route, account source, alert webhook configuration. | [schema](../src/db/schema.ts): `webhookEndpoints`; [endpoint service](../src/lib/webhooks/endpoints.ts). |
| webhook delivery | A delivery attempt lifecycle for one internal event fanned out to one webhook endpoint. | publishing delivery, inbox outbound delivery, inbound webhook event. | [schema](../src/db/schema.ts): `webhookDeliveries`; [dispatcher](../src/lib/webhooks/dispatch.ts). |

## Existing naming differences

Measured 2026-10-20: occurrences include comments and string literals in `src`, `worker`, `landing/src`, excluding `*.test.ts`, `*.integration.test.ts`, `**/__fixtures__/**`, `**/vendor/**`, `*.css`, `*.svg`; they are occurrences, not matching-line counts.

| Spellings and occurrences | Canonical usage and boundary |
| --- | --- |
| PostStack **115** / ReplyStack **5** (case-insensitive whole words) | **PostStack** dominates and is the default `BRAND.name`; ReplyStack is historical, retained in license product aliases and the worker heartbeat filename, not a second running product. |
| `profile` **72** / `brand_key` **32** (case-sensitive whole identifiers) | `profile` dominates the raw count, but these span different contexts: retain **`content.profile`** for the editorial contract and **`channels.brand_key`** for channel assignment; both carry `brands.key`, while `BRAND` names the product. |
| `autoReply` **9** / `auto_reply` **9** (case-sensitive whole identifiers) | Tied count; retain **`autoReply`** in post input and **`auto_reply`** in DB rows, mapped by the existing service, with no global winner. |
| `SocialProvider` **20** / `Provider` **35**; `getProvider` **69** (case-sensitive whole identifiers) | These are **different contracts**, not competing names for one type; qualify the module (`platforms` for inbox, `providers` for publishing) when the context is ambiguous. |
| `"x"` **12** / `"twitter"` **8** (double-quoted literals) | **X** is the service; the dominant literal `x` is canonical for editorial posts/publish providers, while the channel enum requires `twitter`; use `channelMatchesPlatform` / `providerIdForPlatform` instead of substituting strings. |
| `"instagram_login"` **13** / `instagram-login` **16** (literal / substring) | **Instagram Business Login** has existing context-specific spellings: `instagram_login` is a messaging-connection classification, `/api/oauth/instagram-login` is a route, and the channel platform remains `instagram`; the route-count majority does not rename the classification. |

Reproduce a count with `rg -o --no-filename` plus the exclusions above and the corresponding regex, piping to `wc -l` (product regexes: `(?i)\bpoststack\b` / `(?i)\breplystack\b`; identifiers: `\bprofile\b`, etc.). Do not mechanically merge different concepts just because a shorter spelling has more hits.
