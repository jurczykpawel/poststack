# One Token Setup — connect every Page & Instagram account with a single Meta System User token

This is PostStack's "turbo" onboarding: you deploy on your own VPS, generate **one** permanent
Meta **System User** token, paste it once, and PostStack automatically connects **every** Facebook
Page and linked Instagram account that the System User can access — and keeps that set in sync.

> This document is written around **invariants** (what is always true about System User tokens and
> how PostStack consumes them), not around Meta's UI, because Meta moves menus and renames screens
> often. The exact button labels you see may differ from any screenshot; the *concepts* below do
> not. If you get stuck, the **[For agents](#for-agents)** section at the end tells an AI assistant
> how to walk you through your *current* Meta UI using up-to-date docs and what you see on screen.

---

## What you get

Paste one token →

- Every **Facebook Page** the System User has a role on is connected as a channel.
- Every **Instagram** business account linked to those Pages is connected.
- PostStack auto-subscribes each Page's webhooks (no manual webhook wiring per Page).
- A **daily sync** re-enumerates: newly-added Pages appear automatically; removed ones are
  soft-deleted.
- Because a System User token is **permanent**, there is no 60-day refresh and no ~90-day
  data-access wall to babysit — it is the only Meta token shape that never expires.

This is the **Managed Connection** feature (PRO). The free tier connects a single Page manually.

> **Prerequisite — put the Meta app in Live mode.** Connecting the token mints the channels and
> subscribes their webhooks, but Meta only delivers **real** webhook events (incoming DMs, comments)
> when the app is in **Live** mode — in **Development** mode it sends only *test* events from the App
> Dashboard, even for your own Pages. Switch the app to **Live** (a one-time toggle that just needs a
> Privacy Policy URL on the app). This is **not** App Review — see
> [README → Meta Access Levels](../README.md#meta-access-levels--what-needs-app-review-and-what-doesnt).

---

## The mental model — the three things that must be true

Everything below is just a way to satisfy these three invariants. If all three hold, the token
works; if one is missing, PostStack will tell you which (see [Troubleshooting](#troubleshooting)).

1. **It is a Business *System User* token.** A System User is a non-human "service account" that
   lives inside a Meta **Business** (a.k.a. Business Manager / Business Portfolio). Its token is the
   only kind that can be issued with **no expiry**. (A token from your personal login is a *User*
   token — it works, but it expires and hits the ~90-day data-access wall, so it is not the
   set-and-forget path.)

2. **The System User can reach your assets *and* your app.** Inside the Business, the System User
   must have **your Facebook Pages assigned** to it (which carries the linked Instagram accounts),
   **and** your PostStack **Meta app assigned** to it. Assigning the assets is what makes them show
   up; assigning the app is what lets you mint a token *for that app*.

3. **The token is generated for *your* app, with the right permissions, and set to never expire.**
   The token must be minted against the same app whose `META_APP_ID` / `META_APP_SECRET` PostStack
   uses, must carry the permissions listed below, and should be generated with the **"never" /
   no-expiration** option.

---

## Required permissions on the token

When you generate the System User token, grant these scopes. The names are Meta **Graph API
permission** identifiers — they are part of the API contract and change far less often than the UI.

| Permission | Why PostStack needs it |
|---|---|
| `pages_show_list` | Enumerate the Pages behind the token (the core of "connect everything"). **Required** — without it nothing connects. |
| `pages_messaging` | Receive & send Facebook Messenger DMs (inbox + auto-reply + comment→DM private replies). |
| `pages_read_engagement` | Read post comments (comment triggers). |
| `pages_manage_metadata` | Subscribe each Page's webhooks so events flow in. |
| `instagram_basic` | Discover the Instagram business account linked to each Page. **Required for Instagram.** |
| `instagram_manage_messages` | Receive & send Instagram DMs (inbox + auto-reply). |
| `instagram_manage_comments` | Read & reply to Instagram comments (comment triggers + comment→DM). |
| `business_management` *(recommended)* | Lets the System User list/own Business assets reliably during enumeration. |

> **Own accounts vs other people's accounts:** if every Page/IG belongs to *your* Business, these
> all operate under **Standard Access** — no Meta App Review needed. App Review is only required to
> operate accounts owned by people who have no role on your app. See **README → Meta Access Levels**
> for the full breakdown. (One edge case even on your own accounts: the emoji-reaction webhook
> `message_reactions` only fires once the app has Advanced Access on `pages_messaging`.)

> **Instagram direct messages need Instagram Business Login.** A System User connects **every** Page
> and its linked Instagram account in one shot, but at **Standard Access it covers only Instagram
> *publishing* and *comments* — it does NOT deliver Instagram direct messages.** (Delivering IG DMs
> through the Facebook/System-User path would require Meta **Advanced Access** / App Review, which
> self-hosters typically skip.) To enable DMs on an Instagram account — inbox, auto-reply,
> comment-to-DM, follow-gate — additionally connect **that** account via **Instagram Business Login**
> (the **"+ Instagram (messaging)"** button on the Channels page), which needs `INSTAGRAM_APP_ID` /
> `INSTAGRAM_APP_SECRET` set on the instance. That connection runs at Standard Access too (no App
> Review for your own account). The permissions table above still applies to the System-User connection.

---

## Setup — concept-level walkthrough

Do this once. The headings are the *concepts* to look for in Meta's Business settings; the precise
menu names may differ in your version of the UI.

1. **Have a Meta Business.** If you don't already manage your Pages inside a Business (Business
   Manager / Business Portfolio), create one and **add your Facebook Page(s)** to it. Linked
   Instagram business accounts come along with their Page.

2. **Add your PostStack Meta app to the Business.** The app is the one you created in
   [README → Meta App Setup](../README.md#meta-app-setup) (the one whose App ID/Secret are in your
   `.env`). It must belong to / be claimed by the same Business.

3. **Create a System User** in the Business's settings (look for "System users" under business
   users/accounts). Give it an **Admin** role so it can act on the Pages.

4. **Assign assets to the System User:** assign your **Pages** (and, where the UI lists them
   separately, the **Instagram accounts**) and assign your **app** to this System User. Grant full
   control over the Pages.

5. **Generate a token for the System User:**
   - choose **your PostStack app** as the app the token is for,
   - set expiration to **Never** (this is what makes it permanent),
   - select the **permissions** from the table above,
   - generate and copy the token. **Copy it immediately** — Meta shows it once.

6. **Paste it into PostStack:** open your instance → the **Sources / Connections** area (Settings) →
   "connect a managed source" → paste the token. (Or via the API: `POST /api/v1/sources` with the
   token, using an API key that has the `sources:write` scope.)

That's it. PostStack validates the token, enumerates everything, and mints the channels.

---

## What success looks like

After pasting, PostStack shows the source with a badge. **The badge is your diagnostic** — it
reflects what Meta's `debug_token` actually reports about your token:

- ✅ **"System User (permanent) · data access never expires"** — perfect. This is the permanent,
  set-and-forget shape. PostStack detects it as a System User token because Meta reports it as a
  USER-type token with **no death clock and no data-access wall**.
- ⚠️ **"User token · data access until <date>"** — this is **not** a permanent System User token.
  Either you pasted a personal-login token, or the System User token was generated **with** an
  expiry. It will work for now but will expire/hit the wall. Regenerate the System User token with
  the **Never** expiration option.

Below the source you'll see the connected channels (Pages + IG), each with its name/@handle and
status. Newly-added Pages will appear after the next daily sync (or trigger a manual re-sync from
the source).

---

## Troubleshooting

PostStack rejects a bad token **up front** with a specific message (these strings are stable — they
come from PostStack, not Meta):

| Message | Meaning & fix |
|---|---|
| *"This token is missing permissions required for …: `<list>`."* | The token wasn't generated with all required scopes. Regenerate it and tick the missing permissions. |
| *"This access token belongs to a different Facebook app. Generate a token for THIS app."* | The token was minted for another app. Generate it against the app whose `META_APP_ID` PostStack uses. |
| *"This access token is invalid or expired. Generate a fresh token and try again."* | The token is revoked/expired. Mint a fresh one (and set expiry to Never). |
| *"This token did not resolve to a Meta account. Paste a User or System User token."* | You likely pasted a Page token or a malformed string. Paste the **System User** token. |
| *"Could not read the account this token belongs to …"* | Transient Meta/network issue, or a bad token. Retry; if it persists, regenerate. |
| Channels connected, but **no incoming DMs/comments ever arrive** | The Meta app is in **Development** mode — Meta only delivers real webhooks once the app is **Live**. Switch it to Live (see the prerequisite note above). |
| A Page or IG account is **missing** from the connected list | The System User doesn't have that asset assigned, or lacks full control. Assign it in the Business and re-sync. |
| IG account missing for a Page that *is* connected | The Page has no **linked Instagram business account**, or `instagram_basic` wasn't granted. Link the IG account to the Page (Instagram must be a *business/creator* account) and ensure the scope is present. |

> **Why PostStack can validate this at all:** when app credentials are configured it calls Meta's
> `GET /debug_token` to read the token's app, validity, both expiry clocks, and granted scopes —
> so it can tell you *exactly* what's wrong instead of a generic failure. If app credentials aren't
> set yet, validation is skipped and the connect is attempted directly.

---

## For agents

If a user asks you to help set up the one-token / System User connection, follow this:

- **Do not rely on memorized Meta UI steps.** Meta renames and relocates these screens frequently.
  Before giving click-by-click directions, **fetch the current official docs** (e.g.
  `developers.facebook.com/docs` for System Users & access tokens, and the Meta Business Help
  Center) and base your guidance on what they say **today**.
- **Drive from the three invariants** in [the mental model](#the-mental-model--the-three-things-that-must-be-true),
  not from a fixed script: (1) it's a Business System User token, (2) the System User has the
  Pages/IG **and** the app assigned, (3) the token is for *this* app, with the required scopes, set
  to never expire. Your job is to get the user to satisfy those three — by whatever the current UI
  calls them.
- **Ask the user what they see.** Have them tell you the exact section/button labels on their
  screen and map those to the invariants, rather than assuming the labels. Iterate on their
  feedback.
- **Use PostStack's own signals as ground truth.** The paste-time error messages and the source
  badge ("System User (permanent)" vs "User token · data access until …") tell you precisely
  whether the token satisfies the invariants. Treat the badge as the success check.
- **Never ask the user to paste the raw token into the chat.** It is a long-lived credential — they
  should paste it only into their PostStack instance. Help them verify via the badge and error
  messages, not by reading the token.
- **Confirm the required scopes** from the [permissions table](#required-permissions-on-the-token)
  against the current Meta permission reference; if Meta has renamed or split a permission, prefer
  the live docs and tell the user what changed.
