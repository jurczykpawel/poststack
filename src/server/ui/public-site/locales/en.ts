import { html } from "hono/html";
import { currentBrand, isWhiteLabel } from "@/lib/brand";
import type { PublicPage } from "../pages";
import { publicSiteOrigin } from "../origin";
import type { PublicSiteConfig } from "../config";

export const pages = [
  { path: "/", label: "Home", title: "Your publishing workspace" },
  { path: "/how-it-works", label: "How it works", title: "From your content to your channels" },
  { path: "/features", label: "Features", title: "Tools available in this instance" },
  { path: "/faq", label: "FAQ", title: "Frequently asked questions" },
  { path: "/about", label: "About", title: "About this instance" },
  { path: "/contact", label: "Contact", title: "Contact the instance operator" },
  { path: "/privacy", label: "Privacy", title: "Privacy Policy" },
  { path: "/terms", label: "Terms", title: "Terms of Service" },
  { path: "/data-deletion", label: "Data deletion", title: "Request and manage data deletion" },
] as const;

export function publicContent(page: PublicPage, config: PublicSiteConfig) {
  const brand = currentBrand();
  const contactEmail = isWhiteLabel() ? brand.contactEmail : config.operatorEmail;
  const has = (id: string) => config.integrations.some(i => i.id === id);
  const workflow = html`
    <section>
      <h2>Prepare, review, send</h2>
      <p>Start with content you created and accounts you own or are authorised to manage. Connect each account yourself, review the permissions on the platform's authorisation screen, and return to Channels to confirm the selected identity. Connecting an account does not publish anything by itself.</p>
      <p>In Compose, choose a channel, add your media and caption, and review the format and options offered for that destination. You can publish immediately or select a schedule. The queue records delivery progress and errors so you can check the outcome rather than assume the post is live.</p>
    </section>`;
  const scheduling = html`
    <section>
      <h2>Scheduling and your approval</h2>
      <p>Scheduling records your instruction to send the selected content at the chosen time. Review your destination, media, caption and publishing choices before confirming. Processing time, connection expiry and platform limits can affect delivery. A scheduled time is not a guarantee that a post will appear at that exact moment.</p>${has("tiktok") ? html`
      <p>For TikTok Direct Post, you give the required consent when scheduling. Before sending, the service revalidates the creator's current publishing permissions and choices. If the saved choices are no longer available, delivery waits for your confirmation. Upload to inbox sends a draft to TikTok for you to finish there; it does not use the Direct Post creator-option revalidation.</p>` : ""}
    </section>`;
  const integrations = html`
    <section>
      <h2>Configured connections</h2>
      <p>Explore the platforms configured for this instance and the publishing formats supported by each connection. The account you connect determines the options available in Compose. Authorise your own account to see its current publishing choices.</p><div class="integration-grid">${config.integrations.map(i => html`<section class="integration"><h3>${i.name}</h3>
      <p>${i.formats.length ? html`Publishing formats: ${i.formats.join(", ")}.` : "Messaging or comment management through the connected account."}</p>
      ${i.id === "tiktok" ? html`<p>Requested permissions: <span class="scopes">${i.scopes.join(", ")}</span>.</p>` : ""}
    </section>`)}</div>${has("tiktok") ? html`
      <p>TikTok offers Direct Post and Upload to inbox. Direct Post submits the content using the audience and interaction choices you confirm. Upload to inbox requires you to complete publication in the TikTok app. This connection does not provide a TikTok direct-message inbox.</p>` : ""}
    </section>`;
  const retention = html`
    <section>
      <h2>History and retention</h2>
      <p>${config.retentionDays === 0 ? "Automatic history compaction is disabled for this instance." : html`This instance has a ${config.retentionDays}-day history compaction window. Older webhook, reaction and response-metric details can be replaced by aggregate statistics.`} This setting does not erase all stored content or all personal data. Message retention is configured separately for each workspace, and active workflow records can remain where needed for ongoing delivery. <a href="/contact">Contact the operator</a> about media storage, correspondence and backup retention.</p>
      <p>Backup copies of deleted media files may be kept for a period set by the instance operator and are permanently deleted after that period.</p>
    </section>`;
  const contact = contactEmail ? html`
      <p>Use the <button class="contact-email" type="button" data-contact="${Array.from(contactEmail, c => c.codePointAt(0)).join(",")}">Show contact email</button> to write to the operator of ${brand.name}. The address becomes a clickable email link when JavaScript is available. <noscript>The contact address is ${contactEmail.replace("@", " [at] ").replaceAll(".", " [dot] ")}.</noscript></p>` : html`<p>Please contact the administrator of this instance for assistance and data requests.</p>`;
  const deletion = html`
    <section>
      <h2>Disconnect a channel</h2>
      <p>Sign in, open Channels, select the account and use its removal action. This disables the local channel and clears its saved authorisation credentials. It also stops insights collection for that connection. You can separately revoke the application's access in the destination platform's connected-app settings.</p>
      <p>Disconnecting is not complete data erasure: existing conversations, contacts, content and publishing records can remain. It also does not remove posts already published on a destination platform. Review and remove those posts on that platform separately.</p>
    </section>
    <section>
      <h2>Account, workspace and stored-data requests</h2>
      <p>There is no account or workspace deletion button in this application. Contact the instance operator to request deletion of an account, a workspace or specific stored records. Identify the workspace and connected account involved, describe the data you want removed and say whether you are also asking to end access. The operator must verify your authority before acting on a request.</p><p>Find the operator’s address on the <a href="/contact">Contact page</a>.</p>
      <p>Do not send passwords or authorisation credentials. The operator can explain which records have been removed, what remains and how retained backups are handled. Deletion from this instance does not delete data already processed by a connected platform under its own policies.</p>
      <p>Ask the operator how long backup copies of deleted media files are kept before permanent deletion.</p>
    </section>`;
  switch (page.path) {
    case "/": return html`
    <section class="feature-story"><div><p class="eyebrow">From idea to ready</p><h2>Give your next post a place to take shape.</h2>
      <p>Keep media and captions together in Content, then open Compose to choose a destination. Prepare a draft at your own pace and check the account before you send.</p>
      <p>For creators and authorised account managers, ${brand.name} brings preparation and publishing into one workspace. <a href="/how-it-works">See the publishing steps</a>.</p></div>
      <figure class="content-illustration"><div class="micro-label">Content / Example draft</div><div class="content-sample"><div class="media-art" aria-hidden="true"><span></span><i></i></div><div><span class="status">Draft</span><h3>Your next post</h3><div class="caption-lines" aria-hidden="true"><i></i><i></i><i></i></div><strong>Media + caption</strong><p>Ready for Compose</p></div></div><figcaption>Prepare a draft before choosing when to publish.</figcaption></figure></section>
    ${has("tiktok") ? html`<section class="feature-story capture-story"><div><p class="eyebrow">A closer look</p><h2>Check the details before they go live.</h2><p>Compose puts the creator identity and publishing choices alongside your content. For TikTok, review the audience, interaction controls and consent before submitting.</p><p>Direct Post sends your approved instruction. Upload to inbox leaves the final publication step to you in TikTok.</p><a href="/how-it-works">Understand review and approval →</a></div>
      <figure class="capture"><div class="capture-label">Compose / TikTok</div><div class="capture-options"><img src="/public-compose-tiktok.webp" width="658" height="1066" alt="Example TikTok composer showing Demo Creator, audience selection, interaction controls and submission consent" loading="lazy" decoding="async" /></div><div class="capture-label">Your confirmation before submission</div><div class="capture-consent"><img src="/public-compose-tiktok.webp" width="658" height="1066" alt="TikTok submission consent, confirmed in the example workspace" loading="lazy" decoding="async" /></div><figcaption>Details from the real composer, with demonstration data. Your account determines the available choices. <a class="capture-full" href="/public-compose-tiktok.webp">Open full size</a></figcaption></figure></section>` : ""}
    <section class="feature-story"><div><p class="eyebrow">After you confirm</p><h2>Know where each post stands.</h2><p>Follow the delivery in Queue. See what is scheduled, what has been published and what needs your attention. Open a record to inspect the result before deciding to retry.</p><p>Supported messaging connections also bring conversations, contacts and replies into the workspace. A publishing connection does not automatically include a message inbox.</p><a href="/faq">Read common account questions →</a></div>${deliveryIllustration()}</section>
    <section class="access-note"><h2>${locale.access}</h2><p>${locale.accessText}</p><a href="/contact">Contact the operator →</a></section>`;
    case "/how-it-works": return html`<p class="lead">Follow the full journey from account authorisation to checking a delivery result.</p>${processIllustration()}${workflow}
    <section>
      <h2>Check before confirming</h2>
      <p>Review the selected channel's identity and make sure the media and caption belong to the post you intend to send. Choose only the publishing settings available to that account. Include any commercial-content or other disclosure required for your material. If the application reports a validation problem, correct it before submitting again.</p>
      <p>After sending, open the queue to inspect the delivery. A submitted upload may still be processing at the destination. If a connection requires authorisation again, return to Channels and reconnect with the account you control. Check the result before manually retrying content whose publication status is uncertain.</p>
    </section>${scheduling}`;
    case "/features": return html`<div class="feature-overview"><div><p class="lead">Prepare content, organise delivery and manage supported conversations using the connections listed below.</p><h2>A place for every step.</h2><p>Keep drafts in Content. Choose a destination in Compose. Check each publishing result in Queue.</p><a href="/how-it-works">Follow the publishing workflow →</a></div>${workflowIllustration()}</div>${integrations}
    <section>
      <h2>Content and delivery</h2>
      <p>The content workspace holds media and captions before publication. Compose lets you select destinations and review the options for each. Immediate publishing and scheduling use the queue, which tracks each delivery separately. Platform validation can reject unsupported media or unavailable settings; check the reported result before assuming publication succeeded.</p>
      <p>Supported messaging channels also provide conversations, contacts, keyword-based replies and drip sequences. These actions depend on the connection's permissions and messaging rules. A publishing connection alone does not imply that private messages or every account-management action is supported.</p>
    </section>`;
    case "/faq": return html`<p class="lead">Answers about accounts, permissions and the publishing decisions you make.</p>
    <section>
      <h2>Who can connect an account?</h2>
      <p>Use accounts you own or have permission to manage. Sign in to this instance, start the connection from Channels and approve the requested access on the platform's own screen. You can decline the connection if the requested permissions do not match your intended use.</p>
      <h2>Does a connection publish automatically?</h2>
      <p>No post is created merely by connecting an account. Prepare content in Compose and confirm a publishing or scheduling instruction. Separately configured reply rules and sequences can act on supported incoming messages, so review their settings before enabling them.</p>
      <h2>Why is a destination or option unavailable?</h2>
      <p>Available actions depend on the integration configured here, the permissions granted to your account and the platform's current limits. An expired connection may need authorisation again. Check the delivery message and <a href="/contact">contact the operator</a> if you cannot resolve the issue.</p>
      <h2>Does disconnecting erase my data?</h2>
      <p>It disables the connection and clears its saved credentials, but existing records and already published posts can remain. Read the data deletion page for the difference between disconnecting, requesting local erasure and removing a post on its destination platform.</p>
      <h2>How do I get access, and what does it cost?</h2><p>Workspace access and any service charges are managed by the operator of this instance. Contact the operator to ask about the terms available to you before signing in.</p>
      <h2>How do scheduled posts work?</h2>
      <p>See <a href="/how-it-works">Scheduling and your approval</a> for the confirmation steps and what happens when a destination’s publishing choices change before delivery.</p>
    </section>`;
    case "/about": return html`<p class="lead">${brand.name} is the publishing and conversation workspace available at ${publicSiteOrigin()}.</p>
    <section>
      <h2>Purpose of this instance</h2>
      <p>The service helps creators and authorised account managers organise their own content and send it to accounts they control. It brings preparation, scheduling and delivery results together, with conversation and contact tools for supported messaging channels. It does not grant ownership of an account or permission to reuse someone else's material.</p>
      <p>This public website describes the instance that you reach at this address. Its identity, contact details and connection list reflect the current configuration. The dashboard is opened through the sign-in page. <a href="/contact">Ask the operator</a> about access to a workspace, account setup or the handling of your stored data.</p>
    </section>
    <section>
      <h2>Your decisions remain visible</h2>
      <p>Each publishing instruction starts with your selection of content and destination. Review the caption, media and destination options before confirming. The queue shows processing and delivery outcomes, including cases where a connection needs attention. A third-party platform can apply its own limits or decline a post.</p>
      <p>The service is independent of the connected platforms. Platform names identify the services you can connect. Read How it works for the publishing flow, Features for configured connections, and Privacy for the data involved.</p>
    </section>`;
    case "/contact": return html`<p class="lead">Reach the operator responsible for this instance, its workspaces and data requests.</p>
    <section>
      <h2>Write to the operator</h2>${contact}
      <p>State whether your question concerns signing in, connecting an account, preparing content, scheduling or checking a delivery result. Include the workspace name and the visible name of the affected channel. These details help locate the right record without requesting access to your social account.</p>
    </section>
    <section>
      <h2>For a publishing problem</h2>
      <p>Describe what you expected, what happened and approximately when. Include the delivery status and the message shown by the application. If you attach a screenshot, remove private conversations, credentials and unrelated personal information first. Do not send passwords or authorisation credentials by email.</p>
      <p>A platform may still be processing an upload after submission. Check the queue and the destination account before sending the same content again. If the application asks you to reconnect, use the connection flow while signed in rather than sending login details to support.</p>
    </section>
    <section>
      <h2>Privacy and deletion enquiries</h2>
      <p>For access, correction or deletion requests, identify the account or workspace involved and explain which records your request covers. The operator may need to verify your authority. See Privacy and Data deletion for the difference between removing a connection and requesting erasure of stored information.</p>
    </section>`;
    case "/privacy": return html`<p class="lead">How ${brand.name} processes information when you use this instance.</p>
    <section>
      <h2>Operator and purposes</h2>
      <p>The operator of this instance is responsible for the workspace data processed here. For access, correction, deletion or questions about the legal basis for your use of the service, visit <a href="/contact">Contact</a>.</p>
      <p>The application stores login details, workspace membership, connected account identifiers, encrypted authorisation credentials, uploaded media, captions, schedules and delivery results to provide the actions you request. For supported messaging connections it also processes conversations, contacts and reply automation records.</p>
    </section>${has("tiktok") ? html`<section>
      <h2>TikTok data</h2>
      <p>When you connect TikTok, the application retrieves and stores your account identifier (open_id) and display_name to identify your channel. Access and refresh credentials are stored encrypted with AES-256-GCM, together with expiry information, so the service can carry out your publishing instructions and renew access.</p>
      <p>For Direct Post, the application retrieves your creator nickname, optional username, avatar URL, available privacy levels, comment, Duet and Stitch restrictions, and maximum video duration when supplied by TikTok. Creator information is cached in server memory and reused for up to 60 seconds to display your identity and current choices in Compose; sending a Direct Post queries TikTok again.</p>
      <p>Your media, captions, chosen audience, interaction and commercial-content settings are sent to TikTok for the delivery you approve. The instance keeps the submission choices, consent record, publishing identifier, delivery status and returned post identifier or error information to track that delivery. TikTok connections provide publishing rather than access to your private messages, follower list or email address.</p>
      <p>Channel identity and encrypted credentials remain while the connection is kept; removing the channel clears its credentials. Publishing and consent records can remain after disconnection under the retention practices below. In the TikTok app, open Settings and privacy and remove this app from your app permissions to revoke access. To request removal of stored information here, follow <a href="/data-deletion">Data deletion</a>.</p>
    </section>` : ""}
    <section>
      <h2>Sharing and browser storage</h2>
      <p>Media, captions and publishing choices are transmitted to the destination you select when you request publication or a draft upload. Supported conversation actions send replies to the connected service. Those platforms process received data under their own policies. Review the authorisation screen before granting access.</p>
      <p>This public module does not load analytics or marketing trackers. The application uses a session cookie for sign-in and a theme preference to remember its appearance. The instance can also send aggregate usage telemetry if enabled by its operator; this excludes message content, contacts and social authorisation credentials. Ask the operator about its configuration and any infrastructure logs.</p>
    </section>${retention}
    <section>
      <h2>Control and requests</h2>
      <p>Disconnect an account to stop its local connection and revoke access separately on the platform. Existing records and published posts are not erased by disconnecting. Use the Data deletion page for stored-data requests and contact the operator about backups. You may also raise a privacy concern with the relevant data protection authority.</p>
    </section>`;
    case "/terms": return html`<p class="lead">Conditions for using the ${brand.name} instance at ${publicSiteOrigin()}.</p>
    <section>
      <h2>Accounts and permitted use</h2>
      <p>Use the service only with accounts you own or are authorised to manage. Protect your sign-in details and review activity in your workspace. You are responsible for the content and publishing instructions you approve, including scheduled delivery and any automation you configure. Stop using the service if you do not accept these conditions.</p>
      <p>Do not submit unlawful material, spam, misleading content or material that infringes others' rights. Hold the necessary rights to images, video, music and text, and include the disclosures required for commercial or other regulated content. Connecting an account does not grant rights to material that belongs to someone else.</p>
    </section>
    <section>
      <h2>Your content and platform rules</h2>
      <p>You retain ownership of your content. You authorise the processing and transmission needed for the features you request. Review your destination and publishing choices before confirming. Connected platforms apply their own terms, community rules, account limits and processing decisions. Their availability can change, and a scheduled instruction does not guarantee delivery at an exact time.</p>
      <p>Check the queue for results and keep copies of important material. A connection can expire or require authorisation again. The operator cannot promise uninterrupted service or continued access to a third-party platform. Any separate service agreement and rights that cannot legally be excluded continue to apply.</p>
    </section>
    ${has("tiktok") ? html`<section><h2>TikTok publishing conditions</h2><p>TikTok Direct Post is subject to TikTok’s terms and community rules. Before submission, confirm the Music Usage Confirmation and, for branded content, TikTok’s Branded Content Policy through the links in the composer. Make the appropriate commercial-content disclosures for the post you approve.</p></section>` : ""}
    <section>
      <h2>Ending use and questions</h2>
      <p>Disconnect channels to stop their local connections. Request account or workspace data deletion through the operator; published posts must be managed on their destination platforms separately. Privacy describes the information processed here, and Data deletion explains the available steps.</p><p>Find the operator’s address on the <a href="/contact">Contact page</a>.</p>
    </section>`;
    case "/data-deletion": return html`<p class="lead">Choose the action that matches what you want removed from ${brand.name}.</p>${deletion}${has("tiktok") ? html`<p>To revoke TikTok access, open Settings and privacy in the TikTok app and remove this app from your app permissions.</p>` : ""}<p>Read <a href="/privacy">Privacy</a> for history and retention practices.</p>`;
  }
}

export const locale = {
  lang: "en", skip: "Skip to content", menu: "Explore", mainNav: "Main", footerNav: "Footer",
  app: "Open the app", signature: "Publishing & conversations", product: "Workspace", resources: "Service", legal: "Your data",
  theme: "Change colour theme", light: "Light", dark: "Dark", system: "System",
  overview: "Prepare. Review. Publish.", next: "Make room for your next post.",
  nextText: "Sign in to prepare content and follow its delivery. Need a workspace? Ask your instance operator about access and service terms.",
  description: (title: string, name: string) => `${title}. Explore ${name}: prepare content, review publishing choices, track delivery and manage supported conversations.`,
  heroLead: (name: string) => `${name} brings content, publishing choices and delivery results together for creators and authorised account managers.`,
  related: "Useful links", access: "Access to this instance", accessText: "Your instance operator manages workspace access and any service charges. Contact them for the terms that apply to you.",
};

export function workflowIllustration() {
  return html`<figure class="workspace-illustration">
    <div class="workspace-top"><span class="slashes" aria-hidden="true">//</span><span>Example workflow</span><span class="workspace-dot" aria-hidden="true"></span></div>
    <div class="workspace-body"><div class="workspace-tabs"><span>Content</span><strong>Compose</strong><span>Queue</span></div>
      <div class="compose-example"><div class="media-art" aria-hidden="true"><span></span><i></i><b>Made<br />to share.</b></div>
      <div class="compose-copy"><span class="micro-label">Content → Compose</span><strong>A new idea, ready to go.</strong><p>Media and caption, together.<br />Your account. Your choices.</p><span class="sample-field">Review destination options</span><span class="sample-check">✓ Confirm your publishing choices</span></div></div>
      <div class="queue-example"><div><span class="micro-label">Queue</span><strong>Follow every delivery</strong></div><span class="status">Scheduled</span><span class="status">Published</span></div>
    </div><figcaption>Illustration of the publishing workflow. Available options depend on your connected account.</figcaption>
  </figure>`;
}
export function deliveryIllustration() {
  return html`<figure class="delivery-illustration"><div class="micro-label">Example delivery queue</div>
    <div class="delivery-row"><span class="delivery-symbol" aria-hidden="true">✓</span><div><strong>Published</strong><span>Check the destination result</span></div></div>
    <div class="delivery-row"><span class="delivery-symbol" aria-hidden="true">◷</span><div><strong>Scheduled</strong><span>Waiting for the chosen time</span></div></div>
    <div class="delivery-row"><span class="delivery-symbol" aria-hidden="true">!</span><div><strong>Needs attention</strong><span>Open the record for details</span></div></div>
    <figcaption>Each destination has its own delivery record and status.</figcaption></figure>`;
}
export function processIllustration() {
  return html`<ol class="process-illustration"><li><span>01</span><strong>Connect</strong><p>Authorise your account.</p></li><li><span>02</span><strong>Compose</strong><p>Review content and choices.</p></li><li><span>03</span><strong>Confirm</strong><p>Send now or schedule.</p></li><li><span>04</span><strong>Check</strong><p>Read the delivery result.</p></li></ol>`;
}
