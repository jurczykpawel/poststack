import type { Client, Pool } from "pg";
import meta from "./provider-docs/meta-webhooks.json";

// Shapes reused from classify-post-reaction.test.ts and meta/smoke.integration.test.ts.
// These are existing contract examples, not recordings of live traffic.
export const ENGAGEMENT_AT = "2026-10-25T00:30:00.789Z";
export const ENGAGEMENT_TYPES = ["like", "love", "care", "haha", "wow", "sad", "angry"];
export const ENGAGEMENT_BIG_TOTAL = 1057;

/** An isolated, repeatable dataset shared by HTTP integration and browser checks. */
export async function seedEngagement(db: Client | Pool, workspace: string) {
  const channels: string[] = [];
  for (const [key, name] of [["engdata-a", "Engagement Academy"], ["engdata-b", "Engagement Studio"]]) {
    await db.query("INSERT INTO brands (workspace_id, key, name) VALUES ($1, $2, $3)", [workspace, key, name]);
  }
  for (let i = 0; i < 4; i++) {
    const { rows: [ch] } = await db.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, platform, platform_id, display_name, brand_key, token_encrypted, webhook_secret, status)
       VALUES ($1, $5::platform, $2, $3, $4, 'fixture-only', 'fixture-only', 'active') RETURNING id`,
      [workspace, i === 3 ? "17841400000000001" : `99100000000000${i}`, `Engagement Page ${i}`, i < 2 ? "engdata-a" : "engdata-b", i === 3 ? "instagram" : "facebook"],
    );
    channels.push(ch!.id);
  }
  const reactions = Array.from({ length: ENGAGEMENT_BIG_TOTAL + 60 + 3 + 7 }, (_, i) => {
    const group = i < 1117 ? 0 : i < 1120 ? 1 : 2;
    const post = i < ENGAGEMENT_BIG_TOTAL ? "991000000000000_100" : group === 0 ? `991000000000000_${i}` : `99100000000000${group}_200`;
    const type = ENGAGEMENT_TYPES[i % ENGAGEMENT_TYPES.length]!;
    const value = { item: "reaction", verb: "add", reaction_type: type, post_id: post, from: { id: `882${i}`, name: `Reactor ${i}` }, created_time: Math.floor(Date.parse(ENGAGEMENT_AT) / 1000) };
    return { channel: channels[group], post, reactor: value.from.id, name: value.from.name, type, raw: { field: "feed", value } };
  });
  await db.query(`INSERT INTO post_reactions (workspace_id, channel_id, post_id, reactor_id, reactor_name, reaction_type, created_at)
    SELECT $1, channel::uuid, post, reactor, name, type, $3::timestamp FROM jsonb_to_recordset($2::jsonb)
    AS r(channel text, post text, reactor text, name text, type text)`, [workspace, JSON.stringify(reactions), ENGAGEMENT_AT]);
  await db.query(`INSERT INTO webhook_events (event_key, channel_id, platform, object, event_type, field, raw, handling_status, received_at)
    SELECT 'engdata-' || channel || '-' || reactor, channel::uuid, 'facebook', 'page', 'post_reaction', 'feed', raw, 'recorded', $2::timestamp
    FROM jsonb_to_recordset($1::jsonb) AS r(channel text, reactor text, raw jsonb)`, [JSON.stringify(reactions), ENGAGEMENT_AT]);
  const { rows: [ct] } = await db.query<{ id: string }>("INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Engagement Maja') RETURNING id", [workspace]);
  const conversations: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { rows: [cv] } = await db.query<{ id: string }>("INSERT INTO conversations (workspace_id, channel_id, contact_id, platform) VALUES ($1, $2, $3, 'facebook') RETURNING id", [workspace, channels[i], ct!.id]);
    conversations.push(cv!.id);
  }
  for (let i = 0; i < 60; i++) {
    const group = i < 57 ? 0 : i < 59 ? 1 : 2;
    const mid = `engdata-mid-${i}`;
    await db.query("INSERT INTO messages (conversation_id, direction, text, platform_message_id) VALUES ($1, 'outbound', $2, $3)", [conversations[group], `Course link ${i}`, mid]);
    await db.query(`INSERT INTO message_reactions (workspace_id, channel_id, conversation_id, contact_id, reacted_mid, reaction_type, emoji, created_at)
      VALUES ($1, $2, $3, $4, $5, 'love', '❤️', $6)`, [workspace, channels[group], conversations[group], ct!.id, mid, ENGAGEMENT_AT]);
    const raw = { sender: { id: "882000" }, recipient: { id: `99100000000000${group}` }, timestamp: Date.parse(ENGAGEMENT_AT), reaction: { mid, action: "react", reaction: "love", emoji: "❤️" } };
    await db.query(`INSERT INTO webhook_events (event_key, channel_id, platform, object, event_type, field, raw, handling_status, received_at)
      VALUES ($1, $2, 'facebook', 'page', 'reaction', 'message_reactions', $3, 'recorded', $4)`, [`engdata-${channels[group]}-${mid}`, channels[group], JSON.stringify(raw), ENGAGEMENT_AT]);
  }
  // Comments and story mentions belong to Inbox, not either Engagement counter.
  for (const [type, raw] of [["comment", meta.igCommentUnifiedLogin], ["story_mention", { object: "instagram", entry: [{ id: "17841400000000001", messaging: [{ sender: { id: "232323232" }, recipient: { id: "17841400000000001" }, timestamp: Date.parse(ENGAGEMENT_AT), message: { mid: "engdata-mention", attachments: [{ type: "story_mention", payload: { url: "https://example.com/story" } }] } }] }] }]] as const) {
    await db.query(`INSERT INTO webhook_events (event_key, channel_id, platform, object, event_type, raw, handling_status, received_at)
      VALUES ($1, $2, 'instagram', 'instagram', $3, $4, 'recorded', $5)`, [`engdata-${channels[3]}-${type}`, channels[3], type, JSON.stringify(raw), ENGAGEMENT_AT]);
  }
  await db.query(`INSERT INTO posts (workspace_id, platform, status, platform_post_id, description, published_url)
    VALUES ($1, 'facebook', 'published', '991000000000000_100', 'Engagement course launch', 'https://www.facebook.com/991000000000000/posts/100')`, [workspace]);
  return { channels, contact: ct!.id };
}

export async function clearEngagement(db: Client | Pool, workspace: string, seed: Awaited<ReturnType<typeof seedEngagement>>) {
  await db.query("DELETE FROM webhook_events WHERE channel_id = ANY($1::uuid[])", [seed.channels]);
  await db.query("DELETE FROM contacts WHERE workspace_id = $1 AND id = $2", [workspace, seed.contact]);
  await db.query("DELETE FROM channels WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspace, seed.channels]);
  await db.query("DELETE FROM posts WHERE workspace_id = $1 AND platform_post_id = '991000000000000_100'", [workspace]);
  await db.query("DELETE FROM brands WHERE workspace_id = $1 AND key IN ('engdata-a', 'engdata-b')", [workspace]);
}
