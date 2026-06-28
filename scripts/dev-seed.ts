/**
 * Dev seed — populates a workspace with realistic demo data so every screen has something to show.
 * Idempotent: wipes this workspace's seedable rows, then re-inserts. DEV ONLY (fake encrypted tokens).
 *
 *   SEED_EMAIL=dev2@local.test bun scripts/dev-seed.ts
 */
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import * as s from "@/db/schema";
import { encryptTokens } from "@/lib/crypto";

const EMAIL = process.env.SEED_EMAIL ?? "dev2@local.test";
const tok = () => encryptTokens({ access_token: "seed-fake-token", token_type: "page" });
const wh = () => randomBytes(16).toString("hex");
const ago = (mins: number) => new Date(Date.now() - mins * 60_000);
const ahead = (mins: number) => new Date(Date.now() + mins * 60_000);

async function main() {
  const user = await db.query.users.findFirst({ where: eq(s.users.email, EMAIL) });
  if (!user) throw new Error(`No user ${EMAIL} — register it first (REGISTRATION_ENABLED=true).`);
  const member = await db.query.workspaceMembers.findFirst({ where: eq(s.workspaceMembers.user_id, user.id) });
  if (!member) throw new Error(`User ${EMAIL} has no workspace.`);
  const ws = member.workspace_id;

  // ── wipe (FK-safe order; cascades handle children) ──────────────────────────────
  await db.delete(s.messageReactions).where(eq(s.messageReactions.workspace_id, ws));
  await db.delete(s.commentLogs).where(eq(s.commentLogs.workspace_id, ws));
  await db.delete(s.conversations).where(eq(s.conversations.workspace_id, ws));
  await db.delete(s.contacts).where(eq(s.contacts.workspace_id, ws));
  await db.delete(s.deliveries).where(eq(s.deliveries.workspace_id, ws));
  await db.delete(s.posts).where(eq(s.posts.workspace_id, ws));
  await db.delete(s.content).where(eq(s.content.workspace_id, ws));
  await db.delete(s.sequences).where(eq(s.sequences.workspace_id, ws));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, ws));
  await db.delete(s.accountSources).where(eq(s.accountSources.workspace_id, ws));
  await db.delete(s.brands).where(eq(s.brands.workspace_id, ws));

  // ── brands ──────────────────────────────────────────────────────────────────────
  await db.insert(s.brands).values([
    { workspace_id: ws, key: "techskills", name: "TechSkills Academy", accent: "#7aa2f7", icon: "🚀" },
    { workspace_id: ws, key: "flowgrammer", name: "Flowgrammer", accent: "#bb9af7", icon: "⚡" },
  ]);

  // ── channels (slot = brand_key + platform) ────────────────────────────────────────
  const chRows = [
    { platform: "instagram" as const, platform_id: "seed_ig_tsa", display_name: "TechSkills Academy", username: "techskills", brand_key: "techskills" },
    { platform: "facebook" as const, platform_id: "seed_fb_tsa", display_name: "TechSkills Academy", username: "techskills.academy", brand_key: "techskills" },
    { platform: "youtube" as const, platform_id: "seed_yt_tsa", display_name: "TechSkills Academy", username: "techskills", brand_key: "techskills" },
    { platform: "gmail" as const, platform_id: "seed_gmail_tsa", display_name: "kontakt@techskills.academy", username: "kontakt", brand_key: "techskills" },
    { platform: "instagram" as const, platform_id: "seed_ig_flow", display_name: "Flowgrammer", username: "flowgrammer", brand_key: "flowgrammer" },
    { platform: "youtube" as const, platform_id: "seed_yt_flow", display_name: "Flowgrammer", username: "flowgrammer", brand_key: "flowgrammer" },
  ];
  const channels = await db.insert(s.channels).values(
    chRows.map((c) => ({
      workspace_id: ws, platform: c.platform, platform_id: c.platform_id,
      display_name: c.display_name, username: c.username, brand_key: c.brand_key,
      token_encrypted: tok(), webhook_secret: wh(),
      status: "active" as const, connection_mode: "manual_token" as const,
      metadata: c.platform === "instagram" ? { subKind: "instagram" } : {},
    })),
  ).returning({ id: s.channels.id, platform: s.channels.platform, platform_id: s.channels.platform_id });
  const ch = (pid: string) => channels.find((c) => c.platform_id === pid)!.id;
  const igTsa = ch("seed_ig_tsa"), fbTsa = ch("seed_fb_tsa"), gmailTsa = ch("seed_gmail_tsa");

  // ── contacts ──────────────────────────────────────────────────────────────────────
  const contacts = await db.insert(s.contacts).values([
    { workspace_id: ws, display_name: "Marta Kowalska", last_interaction_at: ago(5) },
    { workspace_id: ws, display_name: "Tomasz Nowak", last_interaction_at: ago(140) },
    { workspace_id: ws, display_name: "Anna Wiśniewska", email: "anna@firma.pl", last_interaction_at: ago(360) },
    { workspace_id: ws, display_name: "Piotr Zięba", last_interaction_at: ago(1480) },
  ]).returning({ id: s.contacts.id, name: s.contacts.display_name });
  const cId = (n: string) => contacts.find((c) => c.name === n)!.id;
  const marta = cId("Marta Kowalska"), tomasz = cId("Tomasz Nowak"), anna = cId("Anna Wiśniewska"), piotr = cId("Piotr Zięba");

  await db.insert(s.contactChannels).values([
    { contact_id: marta, channel_id: igTsa, platform_sender_id: "ig_marta_001", platform_username: "marta.k" },
    { contact_id: tomasz, channel_id: fbTsa, platform_sender_id: "fb_tomasz_001", platform_username: "tnowak" },
    { contact_id: anna, channel_id: gmailTsa, platform_sender_id: "anna@firma.pl", platform_username: "anna@firma.pl" },
    { contact_id: piotr, channel_id: igTsa, platform_sender_id: "ig_piotr_001", platform_username: "piotr.zet" },
  ]);

  // ── conversations + messages ────────────────────────────────────────────────────
  const [martaConv] = await db.insert(s.conversations).values({
    workspace_id: ws, channel_id: igTsa, contact_id: marta, platform: "instagram",
    thread_type: "dm", status: "open", unread_count: 1, needs_manual_reply: true,
    last_message_preview: "Tak, poproszę!", last_message_at: ago(5), last_inbound_at: ago(5),
  }).returning({ id: s.conversations.id });
  await db.insert(s.messages).values([
    { conversation_id: martaConv.id, direction: "inbound", text: "Cześć! Czy kurs „Automatyzacje bez kodu” jest jeszcze dostępny?", status: "sent", platform_message_id: "m_marta_1", created_at: ago(9) },
    { conversation_id: martaConv.id, direction: "outbound", text: "Hej Marta! Tak — zapisy do niedzieli. Podesłać Ci link?", status: "sent", platform_message_id: "m_marta_2", created_at: ago(7), delivered_at: ago(7), read_at: ago(6) },
    { conversation_id: martaConv.id, direction: "inbound", text: "Tak, poproszę!", status: "sent", platform_message_id: "m_marta_3", created_at: ago(5) },
  ]);
  await db.insert(s.messageReactions).values({
    workspace_id: ws, channel_id: igTsa, conversation_id: martaConv.id, contact_id: marta,
    reacted_mid: "m_marta_2", reaction_type: "love", emoji: "❤️",
  });

  const [annaConv] = await db.insert(s.conversations).values({
    workspace_id: ws, channel_id: gmailTsa, contact_id: anna, platform: "gmail",
    thread_type: "email", status: "open", unread_count: 1, needs_manual_reply: true, is_automation_paused: true,
    subject: "Współpraca — webinar dla zespołu (~40 osób)",
    last_message_preview: "Dzień dobry, piszę w sprawie współpracy…", last_message_at: ago(360), last_inbound_at: ago(360),
  }).returning({ id: s.conversations.id });
  await db.insert(s.messages).values({
    conversation_id: annaConv.id, direction: "inbound",
    text: "Dzień dobry,\n\npiszę w sprawie współpracy przy webinarze dla naszego zespołu (~40 osób). Czy moglibyśmy umówić krótką rozmowę w przyszłym tygodniu?\n\nPozdrawiam,\nAnna",
    status: "sent", platform_message_id: "m_anna_1", created_at: ago(360),
  });

  // comment threads (Tomasz on FB, Piotr on IG) — each a per-post conversation + a comment_log
  const [tomaszConv] = await db.insert(s.conversations).values({
    workspace_id: ws, channel_id: fbTsa, contact_id: tomasz, platform: "facebook",
    thread_type: "comment", thread_ref: "post_fb_001", status: "open",
    last_message_preview: "Świetny materiał, dzięki!", last_message_at: ago(140), last_inbound_at: ago(140),
  }).returning({ id: s.conversations.id });
  const [piotrConv] = await db.insert(s.conversations).values({
    workspace_id: ws, channel_id: igTsa, contact_id: piotr, platform: "instagram",
    thread_type: "comment", thread_ref: "post_ig_001", status: "open",
    last_message_preview: "LINK proszę", last_message_at: ago(1480), last_inbound_at: ago(1480),
  }).returning({ id: s.conversations.id });
  await db.insert(s.commentLogs).values([
    { workspace_id: ws, channel_id: fbTsa, conversation_id: tomaszConv.id, post_id: "post_fb_001", post_url: "https://facebook.com/techskills/posts/001", platform_comment_id: "cmt_fb_1", author_id: "fb_tomasz_001", author_name: "Tomasz Nowak", comment_text: "Świetny materiał, dzięki! 🔥", dm_sent: true, reply_sent: true, reply_text: "Dzięki Tomasz! 🙌" },
    { workspace_id: ws, channel_id: igTsa, conversation_id: piotrConv.id, post_id: "post_ig_001", post_url: "https://instagram.com/p/abc", platform_comment_id: "cmt_ig_1", author_id: "ig_piotr_001", author_name: "Piotr Zięba", comment_text: "LINK proszę", dm_sent: true, reply_sent: false },
  ]);

  // ── content + posts + a scheduled delivery (Content / Queue) ──────────────────────
  const [c1] = await db.insert(s.content).values({
    workspace_id: ws, title: "5 automatyzacji, które oszczędzają godzinę dziennie", content_type: "video",
    profile: "techskills", status: "published", language: "pl",
    base_description: "Zbudowałem self-hosted scheduler, który publikuje na każdy kanał z jednego ekranu.",
    base_hashtags: "#automatyzacja #selfhosted", media_urls: ["https://example.com/reel.mp4"],
  }).returning({ id: s.content.id });
  const [c2] = await db.insert(s.content).values({
    workspace_id: ws, title: "Jak podpiąć własną aplikację Meta (krok po kroku)", content_type: "video",
    profile: "techskills", status: "draft", language: "pl",
    base_description: "Najczęstsza blokada przy starcie — pokazuję cały proces.", base_hashtags: "#meta #api",
  }).returning({ id: s.content.id });
  await db.insert(s.posts).values([
    // platform_post_id matches the seeded comment_logs.post_id so the inbox resolves the comment's post
    // back to this content's title ("5 automatyzacji…") instead of showing the raw id.
    { workspace_id: ws, content_id: c1.id, platform: "facebook", description: "5 automatyzacji…", hashtags: "#automatyzacja", status: "published", published_at: ago(2880), platform_post_id: "post_fb_001" },
    { workspace_id: ws, content_id: c1.id, platform: "instagram", description: "5 automatyzacji…", hashtags: "#automatyzacja", status: "published", published_at: ago(2880), media_url: "https://example.com/reel.mp4", platform_post_id: "post_ig_001" },
    { workspace_id: ws, content_id: c1.id, platform: "youtube", description: "5 automatyzacji…", status: "published", published_at: ago(2880) },
    { workspace_id: ws, content_id: c2.id, platform: "instagram", description: "Meta app setup", status: "scheduled", scheduled_date: ahead(180) },
    { workspace_id: ws, content_id: c2.id, platform: "facebook", description: "Meta app setup", status: "planned" },
  ]);
  await db.insert(s.deliveries).values([
    { workspace_id: ws, channel_id: igTsa, format: "video", status: "scheduled", scheduled_at: ahead(180), idempotency_key: "seed_del_1", payload: { kind: "video", caption: "Meta app setup" } },
    { workspace_id: ws, channel_id: fbTsa, format: "image", status: "failed", scheduled_at: ago(60), attempts: 3, last_error: "Token expired — reconnect channel", idempotency_key: "seed_del_2", payload: { kind: "image", caption: "promo" } },
  ]);

  // ── a sequence (Compose picker + /sequences) ──────────────────────────────────────
  await db.insert(s.sequences).values({
    workspace_id: ws, name: "Welcome drip", status: "active",
    steps: [{ delay_minutes: 0, text: "Cześć! Dzięki za kontakt 🙌" }, { delay_minutes: 1440, text: "Hej, jeszcze raz — masz pytania o kurs?" }],
  });

  console.log(`✅ Seeded workspace ${ws} (${EMAIL}): 2 brands, ${channels.length} channels, 4 contacts, 4 conversations, 2 content + 4 posts, 2 deliveries, 1 sequence.`);
  process.exit(0);
}

main().catch((e) => { console.error("seed failed:", e); process.exit(1); });
