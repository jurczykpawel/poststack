/**
 * Single source of truth for all landing-page copy & content.
 * Edit text, add/remove cards, toggle testimonials — no component changes needed.
 */

export const site = {
  name: "PostStack",
  title: "PostStack — own your social automation",
  description:
    "Self-hosted social media management for Facebook, Instagram, YouTube, Telegram & Gmail (more coming): unified inbox, keyword auto-replies, AI-drafted replies, comment-to-DM funnels, drip sequences, CRM, publishing and a REST API — on your own server, with no per-contact fees.",
  domain: "https://poststack.techskills.academy",
  // The app and its marketing page are one deployment on the same domain; /login is the app entry.
  appUrl: "https://poststack.techskills.academy/login",
  ctaUrl: "https://sellf.techskills.academy/p/poststack-pro",
  docsUrl: "https://github.com/jurczykpawel/poststack",
  githubUrl: "https://github.com/jurczykpawel/poststack",
};

export const nav = [
  { label: "Capabilities", href: "#capabilities" },
  { label: "Workflow", href: "#workflow" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export const hero = {
  badge: "Self-hosted · flat cost · no per-contact fees",
  titleLead: "Own your",
  titleAccent: "social automation",
  subtitle:
    "Run your whole inbox, automation and publishing across Facebook, Instagram, YouTube, Telegram & Gmail — on your own server, with no per-contact fees. More channels on the way.",
  primaryCta: "Get PostStack",
  secondaryCta: "Self-host for free",
  // Prominent objection-buster shown under the CTAs; links to the dedicated MetaAccess section.
  assurance: { lead: "No verified Meta app needed", tail: "for your own accounts", href: "#meta-access" },
};

/**
 * Supported channels. `live` = providers shipping today; `planned` = reserved,
 * arriving via the provider pattern. Add a platform here → it shows on the bar.
 */
export const platforms = {
  eyebrow: "One platform, every channel",
  title: "Connect the channels you already use",
  // Full two-way messaging: inbox, auto-reply and comment-to-DM.
  live: ["Facebook", "Instagram", "YouTube", "Telegram", "Gmail"],
  // Publish & schedule only — these platforms have no open inbound-messaging API, so there is no inbox
  // or auto-reply for them (and won't be until that changes upstream).
  publishing: ["TikTok", "X", "LinkedIn", "Threads"],
  // Messaging channels on the way (their APIs do support inbound).
  planned: ["WhatsApp", "Email (IMAP/SMTP)", "SMS", "Discord"],
  note: "Messaging channels get the full inbox + auto-reply; publishing channels schedule and post. Each is one TypeScript provider class — and you can add your own.",
  // TikTok caveat (rendered with a * on the TikTok chip, linking to the README section).
  tiktokNote:
    "* TikTok publishing posts to your TikTok inbox as a draft you finish & confirm in the app — full auto-publish requires TikTok's app approval.",
  tiktokNoteUrl: "https://github.com/jurczykpawel/poststack#tiktok-publishing",
  // Telegram caveat (rendered with a * on the Telegram chip): it connects as a bot and only handles
  // private 1:1 DMs. Keep this honest — the provider has no publish, no comment surface, and groups /
  // channels / Telegram Business inboxes aren't handled yet.
  telegramNote:
    "† Telegram is an early, proof-of-concept integration: it connects as a bot and handles private 1:1 DMs (text) only — a bot can't message someone until they start the chat. Groups, channels and Telegram Business account inboxes aren't supported yet; deeper Telegram integration is on the roadmap.",
};

export const proofSignals = [
  "Source-available",
  "One-command Docker deploy",
  "Meta inbox + automation",
  "REST API-first",
  "No vendor lock-in",
];

/**
 * Objection-buster: you do NOT need a Meta-approved app to run PostStack on your own accounts.
 * Detail lives in the public README → "Meta Access Levels". Keep `linkUrl` pointed at that anchor.
 */
export const metaAccess = {
  eyebrow: "No gatekeeping",
  title: "No verified Meta app required",
  accent: "verified Meta app",
  intro:
    "A common myth: that Meta has to approve your app before you can automate Instagram & Facebook. You don't — not for your own accounts. Connect Instagram directly (no Facebook Page required) and go.",
  cards: [
    {
      heading: "Your own accounts",
      ok: true,
      body: "Inbox, auto-reply, comment→DM and drip sequences all work under Meta's default Standard Access. No App Review, no Business Verification. Connect an Instagram account directly with Instagram Business Login — no Facebook Page needed — and still get DMs and the follow-gate.",
    },
    {
      heading: "Clients' accounts",
      ok: false,
      body: "Only if you operate other people's accounts (an agency / reseller setup) does Meta need Advanced Access — App Review + Business Verification. That's the line, and it's optional.",
    },
  ],
  note: "One-time setup: switch the Meta app to Live mode (a toggle, not a review) so production webhooks flow.",
  general:
    "Same story across the board: every channel PostStack supports today — Facebook, Instagram, YouTube, Telegram and Gmail — runs on a standard developer app you create yourself. No weeks-long app review and no identity or business verification to use your own accounts — just normal app configuration (Telegram is literally one bot token).",
  linkLabel: "See exactly what needs review",
  linkUrl:
    "https://github.com/jurczykpawel/poststack#meta-access-levels--what-needs-app-review-and-what-doesnt",
};

/**
 * Lead capture: collect a contact's email/phone from a Meta DM and forward it anywhere.
 * Backed by the user_email/user_phone_number quick replies + the contact.updated outbound webhook.
 */
export const leadCapture = {
  eyebrow: "Lead capture",
  title: "Turn a DM into a mailing-list contact",
  accent: "mailing-list contact",
  intro:
    "Ask for an email or phone number with a single tap — Facebook and Instagram pre-fill it from the user's profile, so they confirm instead of typing. It lands on the contact in your CRM and fires a webhook the moment it's captured.",
  steps: [
    {
      n: "01",
      heading: "Ask with one tap",
      body: "A rule sends an \"email\" or \"phone\" quick reply. Meta pre-fills it from the user's profile — one tap, no typing, no typos.",
    },
    {
      n: "02",
      heading: "Stored in your CRM",
      body: "The captured email/phone is written straight onto the contact, alongside tags, subscription state and conversation history — yours, on your server.",
    },
    {
      n: "03",
      heading: "Webhook to anywhere",
      body: "Capturing a contact fires a signed outbound webhook, so you can push it to Listmonk, n8n, a mailing list or any tool — no lock-in, no built-in email vendor to rent.",
    },
  ],
  note: "Outbound webhooks are a PRO feature; the captured contact carries its id so the receiver can pull email, phone and tags.",
};

/** "You use X when…" contrast block */
export const comparison = {
  others: [
    { tool: "Buffer", line: "when you only need a clean scheduler." },
    { tool: "ManyChat", line: "when basic DM automation is enough." },
  ],
  us: "when you need scheduling, auto-reply, AI-drafted replies, comment-to-DM funnels, drip sequences, CRM, and a REST API across Facebook, Instagram, YouTube, Telegram & Gmail — on your own server, with no per-contact fees.",
};

/**
 * Pinned, scroll-driven signature section ("the PostStack loop").
 * Captions are data; the visual scenes live in ScrollStory.astro.
 */
export const scrollStory = {
  eyebrow: "The PostStack loop",
  title: "One public comment, fully worked — while you sleep",
  scenes: [
    {
      label: "Capture",
      title: "Someone comments a keyword",
      body: "A follower drops “PRICE” under your Instagram post. PostStack matches it against your rules in real time.",
    },
    {
      label: "Convert",
      title: "The comment becomes a private DM",
      body: "PostStack replies publicly and slides the conversation into the DMs — comment-to-DM, automatically, within Meta's window.",
    },
    {
      label: "Nurture",
      title: "They enter a drip sequence & your CRM",
      body: "The contact is tagged, saved, and enrolled into a timed follow-up sequence. No lead slips through.",
    },
  ],
};

export const capabilities = [
  {
    kicker: "Unified inbox",
    title: "Every DM, comment, and contact in one operational view.",
    body: "Handle DMs, comments, messages and emails across Facebook, Instagram, YouTube, Telegram and Gmail — manual replies, tags, subscriptions, and contact history without jumping between tools.",
    metric: "5 channels live",
  },
  {
    kicker: "Auto-reply rules",
    title: "Turn keywords and events into replies, DMs, and follow-up flows.",
    body: "Build rules for comments, keywords, postbacks, welcome events, stories, and reactions. Reply publicly, privately, or both — with AI rephrase and interactive buttons.",
    metric: "6 trigger types",
  },
  {
    kicker: "AI-drafted replies",
    title: "When no rule matches, an LLM drafts the reply — you approve it.",
    body: "Off-script comments and DMs get an AI-drafted answer waiting in your inbox to accept, edit, or reject — plus an on-demand “Generate reply” button. Never auto-sent by default, and you bring your own model.",
    metric: "Human-approved",
  },
  {
    kicker: "Drip sequences",
    title: "Enroll leads into timed follow-ups from rules or by hand.",
    body: "Create multi-step sequences with delays, manual enrollment, and automatic enrollment from the exact rule that captured intent.",
    metric: "Timed delivery",
  },
  {
    kicker: "Publishing",
    title: "Compose once, schedule across channels, add the first comment.",
    body: "Plan multi-platform posts, schedule delivery, attach media, publish first comments, and trigger Auto-Story workflows from one screen.",
    metric: "Multi-platform",
  },
  {
    kicker: "CRM",
    title: "Keep the relationship context next to the conversation.",
    body: "Tags, subscriptions, contact profiles, and thread history stay connected to the person who just commented or messaged you.",
    metric: "Contact graph",
  },
  {
    kicker: "API-first",
    title: "Use the UI, then automate the same system through REST.",
    body: "Every serious capability is designed around /api/v1 and documented with Scalar for builders who want to connect PostStack to their stack.",
    metric: "/api/v1",
  },
];

/**
 * Interactive auto-reply playground. Click a keyword → the rule fires.
 * Add a rule = one entry here.
 */
export const ruleTester = {
  eyebrow: "Interactive · try it",
  title: "Click a keyword. Watch the rule fire.",
  body: "This is exactly how PostStack answers comments and DMs: match the intent, reply in public or private, then hand off to a sequence — automatically.",
  hint: "Tap a keyword a follower might send",
  rules: [
    {
      keyword: "PRICE",
      comment: "How much is the course? 🙌",
      reply: "Here's the full price list + your discount link 👇",
      buttons: ["View pricing", "Get discount"],
    },
    {
      keyword: "DEMO",
      comment: "Can I see it in action first?",
      reply: "Absolutely — here's a 2-minute walkthrough 🎬",
      buttons: ["Watch demo"],
    },
    {
      keyword: "HELP",
      comment: "I'm stuck on setup 😕",
      reply: "No worries! Here's the setup guide — and a human can jump in too.",
      buttons: ["Open docs", "Talk to us"],
    },
    {
      keyword: "HOURS",
      comment: "What are your support hours?",
      reply: "We're around Mon–Fri, 9–17 CET. Leave your question and we'll reply.",
      buttons: [],
    },
  ],
};

export const followGate = {
  eyebrow: "Auto-reply · PRO",
  title: "Follow-gate —",
  titleAccent: "unlock only after they follow",
  body: "Gate a lead magnet behind a real follow. When someone taps to claim, PostStack live-checks whether they actually follow your Instagram — delivers the magnet if they do, or loops them back with a “follow first” prompt until they do. No honour system: it verifies with Instagram.",
  toggleLabel: "Try it — is this person following you?",
  toggleFollowing: "Following",
  toggleNotFollowing: "Not yet",
  handle: "@your.brand",
  prompt: "Want the free guide? Tap below 👇",
  claimCta: "Claim free guide 🎁",
  reclaimCta: "I followed — claim 🎁",
  lockedTitle: "🔒 Follow to unlock",
  lockedBody: "Follow @your.brand first, then tap again 👇",
  unlockedTitle: "🎉 Unlocked",
  unlockedBody: "Here's your guide 👉 your.brand/guide",
  note: "Instagram only — verified live via the messaging API (is_user_follow_business). Facebook has no public follow graph, so the gate stays open there.",
};

export const workflow = [
  {
    step: "01",
    title: "Connect your channels",
    body: "Attach Facebook, Instagram, YouTube, Telegram and Gmail accounts, then pull DMs, comments, messages and emails into a single inbox.",
  },
  {
    step: "02",
    title: "Create intent rules",
    body: "Map keywords, comments, reactions, stories, or welcome events to public replies, private messages, or both.",
  },
  {
    step: "03",
    title: "Enroll into sequences",
    body: "Move qualified contacts into follow-up sequences with timed delays and channel-aware delivery.",
  },
  {
    step: "04",
    title: "Publish and extend",
    body: "Schedule content, run CRM workflows, and extend everything through the REST API when the UI is not enough.",
  },
];

/**
 * "Publish once" morph — one post fans out to every channel, each marked
 * Scheduled. Channels reuse the live platform list.
 */
export const publishMorph = {
  eyebrow: "Publish once",
  title: "Compose once. Schedule everywhere.",
  body: "Write the post, attach media, pick a time — PostStack publishes across every connected channel and drops the first comment. One screen, every platform.",
  postText: "New episode is live 🎬 full breakdown inside 👇",
  channels: ["Facebook", "Instagram", "YouTube"],
};

export const useCases = [
  {
    title: "Agencies",
    body: "Run automation for multiple brands without pricing that grows every time a client's audience grows.",
  },
  {
    title: "E-commerce",
    body: "Answer product questions, recover comment intent, and move shoppers from public comments to private follow-up.",
  },
  {
    title: "Creators",
    body: "Send lead magnets when someone comments a keyword and keep every subscriber in a lightweight CRM.",
  },
  {
    title: "Developers",
    body: "Self-host the stack, inspect the code, and connect your own tools through a predictable API surface.",
  },
];

/**
 * "Data Flow" section — dramatizes the self-hosted / API-first differentiator:
 * Meta events land on YOUR infrastructure, not inside a SaaS you rent.
 */
export const dataFlow = {
  eyebrow: "Your data, your rules",
  title: "Every event lands on your infrastructure",
  body: "A comment, DM, message or email arrives, PostStack processes it, and writes it straight into your Postgres and your REST API — not into someone else's SaaS where your audience sits behind a per-contact paywall.",
  nodes: {
    source: { label: "Channels", sub: "FB · IG · YT · TG · Gmail" },
    hub: { label: "PostStack", sub: "your server" },
    db: { label: "Postgres", sub: "your database" },
    api: { label: "/api/v1", sub: "your REST API" },
  },
  lockin: "SaaS lock-in: your audience lives on their servers.",
  ours: "PostStack: it lives on yours.",
};

export const founderLetter = {
  body: [
    "PostStack wasn't supposed to be a product. We were running automation for our own brands and got tired of watching the bill climb every time an audience grew. So we built a self-hosted layer on top of the social platforms' APIs — for ourselves.",
    "Then people asked for access. Then their friends did. Today it's a source-available platform for anyone who believes their data and their automation should belong to them.",
    "We're just getting started. Come build with us.",
  ],
  signoff: "Paweł & the PostStack team",
};

export const pricing = [
  {
    name: "Self-hosted",
    price: "Free",
    period: "",
    note: "For builders who want to run the core system themselves.",
    cta: "Self-host for free",
    href: "https://github.com/jurczykpawel/poststack",
    features: [
      "One-command Docker Compose setup",
      "Core inbox & automation",
      "Full source access",
      "Community support",
    ],
  },
  {
    name: "PRO",
    price: "zł349",
    originalPrice: "zł499",
    period: "/ year",
    slug: "poststack-pro",
    note: "Launch price. Commercial license, priority support, and a year of updates.",
    cta: "Get PRO",
    href: "https://sellf.techskills.academy/p/poststack-pro",
    featured: true,
    features: [
      "All product capabilities",
      "Commercial use",
      "Priority support",
      "One year of updates",
    ],
  },
  {
    name: "Lifetime",
    price: "zł899",
    originalPrice: "zł1,299",
    period: "once",
    slug: "poststack-lifetime",
    note: "Launch price. One-time license for teams who keep running their own stack.",
    cta: "Get lifetime",
    href: "https://sellf.techskills.academy/p/poststack-lifetime",
    badge: "Best value",
    features: [
      "Everything in PRO",
      "Lifetime updates",
      "Priority support — first year",
      "Commercial use",
      "No recurring license fee",
    ],
  },
];

/**
 * Public roadmap. Move items between lanes as they ship.
 * status drives the marker colour: live | next | planned.
 */
export const roadmap = {
  eyebrow: "Roadmap",
  title: "Built in the open, growing fast",
  note: "We ship in public — follow along or request a channel on GitHub.",
  lanes: [
    {
      label: "Live now",
      status: "live" as const,
      items: [
        "Messaging: Facebook, Instagram, YouTube & Gmail (Telegram: early bot DM)",
        "Instagram Business Login (connect IG directly, no Facebook Page)",
        "Inbox, auto-reply, AI-drafted replies & comment-to-DM",
        "Publishing to TikTok, X, LinkedIn & Threads",
        "Drip sequences, CRM & REST API",
      ],
    },
    {
      label: "Up next",
      status: "next" as const,
      items: ["WhatsApp messaging", "Email (IMAP/SMTP)", "SMS (Twilio / SMSAPI)", "Discord"],
    },
    {
      label: "On the roadmap",
      status: "planned" as const,
      items: [
        "Deeper Telegram: groups, channels & Business inboxes",
        "Meta Ads & Google Ads management",
        "Visual flow builder",
        "Team roles & permissions",
      ],
    },
  ],
};

/**
 * Testimonials. Set `enabled: true` once real quotes exist.
 * While disabled, the landing shows capability/trust proof instead of fake quotes.
 */
export const testimonialModule = {
  enabled: false,
  intro:
    "Real customer proof lands here once the first public quotes are ready. Until then we lead with the product, not invented reviews.",
  items: [
    { quote: "", author: "", role: "" },
  ],
  /** Shown while testimonials are disabled — honest, verifiable trust signals. */
  fallbackStats: [
    { value: "100%", label: "Your data, your server" },
    { value: "0", label: "Per-contact fees" },
    { value: "2", label: "Meta surfaces (FB + IG)" },
    { value: "REST", label: "API for every feature" },
  ],
};

/**
 * Live fleet stats — aggregate numbers fetched client-side from the public telemetry endpoint.
 * The section is hidden until a successful fetch returns active_instances > 0, so a slow/down
 * endpoint or a zero-instance fleet shows nothing (no layout shift, no zeros, no error text).
 * Only labels live here; the numbers come from the endpoint at runtime.
 */
export const fleetStats = {
  endpoint: "https://telemetry.techskills.academy/public/stats/poststack",
  eyebrow: "Live fleet",
  title: "Running in the wild, right now",
  subtitle: "Aggregate, anonymous numbers from PostStack instances reporting in — no per-instance data.",
  metrics: [
    // Hidden until the fleet is a meaningful size — a low early instance count reads as weak proof.
    { key: "active_instances", label: "Active instances", minToShow: 10 },
    { key: "total_channels", label: "Connected channels" },
    { key: "total_messages_processed", label: "Messages processed" },
    { key: "total_webhooks_processed", label: "Webhooks processed" },
    { key: "avg_response_time_ms", label: "Avg. auto-reply time", kind: "duration" },
  ],
  platformsTitle: "Connected channels by platform",
  note: "Anonymous and opt-out — see exactly what is shared on the",
  noteLinkLabel: "privacy page",
  noteLinkHref: "/privacy#telemetry",
};

export const faq = [
  {
    question: "Do I need my own server to run PostStack?",
    answer:
      "Yes for self-hosting. The target setup is Docker Compose on a VPS — a single deployment that serves both the dashboard and its marketing page from the same domain.",
  },
  {
    question: "Is this a subscription or a one-time purchase?",
    answer:
      "Both are available: PRO is a yearly license, and Lifetime is a single one-time license with no recurring fee.",
  },
  {
    question: "Which platforms can I connect?",
    answer:
      "For two-way messaging (inbox, auto-reply, comment-to-DM): Facebook, Instagram, YouTube, Telegram and Gmail are live today — connect multiple accounts of each. Instagram can be connected directly via Instagram Business Login (no Facebook Page required, DMs at Standard Access) or through a linked Facebook Page. Gmail is a two-way reply/inbox channel (filter by label or query, read-only on your mailbox). Telegram is an early, proof-of-concept integration — it connects as a bot for private 1:1 DMs only (no groups, channels or Telegram Business inboxes yet, and no publishing); deeper Telegram support is on the roadmap. For publishing & scheduling you can also post to TikTok, X, LinkedIn and Threads. Coming next on the messaging side: WhatsApp, SMS (Twilio/SMSAPI), generic email (IMAP/SMTP) and Discord — each ships as one provider class. (TikTok, X, LinkedIn and Threads stay publish-only — those platforms don't expose an inbound-messaging API.)",
  },
  {
    question: "Does the AI-drafted replies feature send my messages to a third party?",
    answer:
      "Only if you turn it on, and only to the model endpoint you configure. AI-drafted replies are bring-your-own-key: point them at OpenAI, a self-hosted model, or any OpenAI-compatible endpoint via AI_BASE_URL. Drafts are never sent to the contact automatically — they wait in your inbox for you to accept, edit, or reject (optional per-channel auto-send is off by default). It's a PRO feature.",
  },
  {
    question: "What happens to my data?",
    answer:
      "Your database and media storage stay under your control. No per-contact lock-in — operational data lives on infrastructure you manage.",
  },
  {
    question: "Do I need Meta app review?",
    answer:
      "For production usage with Meta permissions, expect the normal Meta app setup and review. PostStack gives you the operating layer, not a way around Meta policy.",
  },
  {
    question: "Can I build my own integrations?",
    answer:
      "Yes. The app is API-first and TypeScript-based, so you can drive it through /api/v1 or extend the provider pattern in the codebase.",
  },
  {
    question: "What's the difference between free self-host and a license?",
    answer:
      "The free self-host runs the core system. A PRO or Lifetime license unlocks the full feature set, commercial use, and priority support.",
  },
  {
    question: "What if I'm not happy with the purchase?",
    answer:
      "Reach out and we'll make it right. The whole point of PostStack is removing lock-in — that includes how you feel about the license.",
  },
];

export const footer = {
  tagline: "Self-hosted social automation for people who want to own their stack.",
  // Part of the TechSkills Academy ecosystem — cross-links back to the hub so
  // visitors can discover the sister tools. See techskills.academy ecosystem-footer-standard.
  ecosystem: {
    label: "Part of the TechSkills Academy ecosystem",
    links: [
      { label: "All tools", href: "https://techskills.academy/narzedzia" },
      { label: "Open source", href: "https://techskills.academy/#ekosystem" },
    ],
  },
  columns: [
    {
      heading: "Product",
      links: [
        { label: "Capabilities", href: "#capabilities" },
        { label: "Workflow", href: "#workflow" },
        { label: "Pricing", href: "#pricing" },
        { label: "FAQ", href: "#faq" },
      ],
    },
    {
      heading: "Resources",
      links: [
        { label: "GitHub", href: "https://github.com/jurczykpawel/poststack" },
        { label: "Documentation", href: "https://github.com/jurczykpawel/poststack" },
        { label: "API reference", href: "https://github.com/jurczykpawel/poststack" },
      ],
    },
    {
      heading: "Get started",
      links: [
        { label: "Open the app", href: "https://poststack.techskills.academy/login" },
        { label: "Get a license", href: "https://sellf.techskills.academy/p/poststack-pro" },
      ],
    },
  ],
};
