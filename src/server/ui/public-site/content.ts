import { html } from "hono/html";
import { currentBrand } from "@/lib/brand";
import type { PublicPage } from "./pages";
import type { PublicSiteConfig } from "./config";

export function publicContent(page: PublicPage, config: PublicSiteConfig) {
  const brand = currentBrand();
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
      <p>This list reflects the connection methods configured for this instance. Availability of an action still depends on the permissions you grant, your account type and the platform's approval. Formats below describe supported publishing types; a connected account may offer fewer choices. Permission names identify what the authorisation flow requests, rather than a promise that every permission will be granted.</p><div class="integration-grid">${config.integrations.map(i => html`<section class="integration"><h3>${i.name}</h3>
      <p>${i.formats.length ? html`Publishing formats: ${i.formats.join(", ")}.` : "Messaging or comment management through the connected account."}</p>
      <p>${i.scopes.length ? html`Requested permissions: <span class="scopes">${i.scopes.join(", ")}</span>.` : "Connect a bot you control to manage its messages and publish to destinations where it has permission."}</p>
    </section>`)}</div>${has("tiktok") ? html`
      <p>TikTok offers Direct Post and Upload to inbox. Direct Post submits the content using the audience and interaction choices you confirm. Upload to inbox requires you to complete publication in the TikTok app. This connection does not provide a TikTok direct-message inbox.</p>` : ""}
    </section>`;
  const retention = html`
    <section>
      <h2>History and retention</h2>
      <p>${config.retentionDays === 0 ? "Automatic history compaction is disabled for this instance." : html`This instance has a ${config.retentionDays}-day history compaction window. Older webhook, reaction and response-metric details can be replaced by aggregate statistics.`} This setting does not erase all stored content or all personal data. Message retention is configured separately for each workspace, and active workflow records can remain where needed for ongoing delivery. Contact the operator about media storage, correspondence and backup retention.</p>
    </section>`;
  const contact = html`
      <p>Use the <button class="contact-email" type="button" data-contact="${Array.from(brand.contactEmail, c => c.codePointAt(0)).join(",")}">Show contact email</button> to write to the operator of ${brand.name}. The address becomes a clickable email link when JavaScript is available. <noscript>The contact address is ${brand.contactEmail.replace("@", " [at] ").replaceAll(".", " [dot] ")}.</noscript></p>`;
  const deletion = html`
    <section>
      <h2>Disconnect a channel</h2>
      <p>Sign in, open Channels, select the account and use its removal action. This disables the local channel and clears its saved authorisation credentials. It also stops insights collection for that connection. You can separately revoke the application's access in the destination platform's connected-app settings.</p>
      <p>Disconnecting is not complete data erasure: existing conversations, contacts, content and publishing records can remain. It also does not remove posts already published on a destination platform. Review and remove those posts on that platform separately.</p>
    </section>
    <section>
      <h2>Account, workspace and stored-data requests</h2>
      <p>There is no account or workspace deletion button in this application. Contact the instance operator to request deletion of an account, a workspace or specific stored records. Identify the workspace and connected account involved, describe the data you want removed and say whether you are also asking to end access. The operator must verify your authority before acting on a request.</p>${contact}
      <p>Do not send passwords or authorisation credentials. The operator can explain which records have been removed, what remains and how retained backups are handled. Deletion from this instance does not delete data already processed by a connected platform under its own policies.</p>
    </section>`;
  switch (page.path) {
    case "/": return html`<p class="lead">${brand.name} brings content preparation, publishing and supported channel conversations into one workspace.</p>${workflow}
    <section>
      <h2>Work with your own accounts</h2>
      <p>This instance is intended for authentic creators and authorised account managers publishing their own content. You choose the destination and approve each publishing instruction. Access to the dashboard requires sign-in; connection and reconnection take place inside your authenticated session.</p>
      <p>Keep drafts while preparing a post, schedule approved content and follow the delivery result in the queue. Conversations, keyword replies and contact records are available for supported messaging connections. The pages here describe this instance's current configuration and the steps involved in using it.</p>
    </section>${scheduling}${integrations}`;
    case "/how-it-works": return html`<p class="lead">Follow the full journey from account authorisation to checking a delivery result.</p>${workflow}
    <section>
      <h2>Check before confirming</h2>
      <p>Review the selected channel's identity and make sure the media and caption belong to the post you intend to send. Choose only the publishing settings available to that account. Include any commercial-content or other disclosure required for your material. If the application reports a validation problem, correct it before submitting again.</p>
      <p>After sending, open the queue to inspect the delivery. A submitted upload may still be processing at the destination. If a connection requires authorisation again, return to Channels and reconnect with the account you control. Check the result before manually retrying content whose publication status is uncertain.</p>
    </section>${scheduling}${has("tiktok") ? integrations : ""}`;
    case "/features": return html`<p class="lead">Prepare content, organise delivery and manage supported conversations using the connections listed below.</p>${integrations}
    <section>
      <h2>Content and delivery</h2>
      <p>The content workspace holds media and captions before publication. Compose lets you select destinations and review the options for each. Immediate publishing and scheduling use the queue, which tracks each delivery separately. Platform validation can reject unsupported media or unavailable settings; check the reported result before assuming publication succeeded.</p>
      <p>Supported messaging channels also provide conversations, contacts, keyword-based replies and drip sequences. These actions depend on the connection's permissions and messaging rules. A publishing connection alone does not imply that private messages or every account-management action is supported.</p>
    </section>${scheduling}`;
    case "/faq": return html`<p class="lead">Answers about accounts, permissions and the publishing decisions you make.</p>
    <section>
      <h2>Who can connect an account?</h2>
      <p>Use accounts you own or have permission to manage. Sign in to this instance, start the connection from Channels and approve the requested access on the platform's own screen. You can decline the connection if the requested permissions do not match your intended use.</p>
      <h2>Does a connection publish automatically?</h2>
      <p>No post is created merely by connecting an account. Prepare content in Compose and confirm a publishing or scheduling instruction. Separately configured reply rules and sequences can act on supported incoming messages, so review their settings before enabling them.</p>
      <h2>Why is a destination or option unavailable?</h2>
      <p>Available actions depend on the integration configured here, the permissions granted to your account and the platform's current limits. An expired connection may need authorisation again. Check the delivery message and contact the operator if you cannot resolve the issue.</p>
      <h2>Does disconnecting erase my data?</h2>
      <p>It disables the connection and clears its saved credentials, but existing records and already published posts can remain. Read the data deletion page for the difference between disconnecting, requesting local erasure and removing a post on its destination platform.</p>
    </section>${scheduling}`;
    case "/about": return html`<p class="lead">${brand.name} is the publishing and conversation workspace available at ${brand.publicUrl}.</p>
    <section>
      <h2>Purpose of this instance</h2>
      <p>The service helps creators and authorised account managers organise their own content and send it to accounts they control. It brings preparation, scheduling and delivery results together, with conversation and contact tools for supported messaging channels. It does not grant ownership of an account or permission to reuse someone else's material.</p>
      <p>This public website describes the instance that you reach at this address. Its identity, contact details and connection list reflect the current configuration. The dashboard is opened through the sign-in page. Ask the operator about access to a workspace, account setup or the handling of your stored data.</p>
    </section>
    <section>
      <h2>Your decisions remain visible</h2>
      <p>Each publishing instruction starts with your selection of content and destination. Review the caption, media and destination options before confirming. The queue shows processing and delivery outcomes, including cases where a connection needs attention. A third-party platform can apply its own limits or decline a post.</p>
      <p>The service is independent of the connected platforms. A configured integration is not a claim of endorsement. Read How it works for the publishing flow, Features for configured connections, and Privacy for the data involved.</p>
    </section>${retention}`;
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
      <p>For access, correction or deletion requests, identify the account or workspace involved and explain which records your request covers. The operator may need to verify your authority. See Privacy and Data deletion for the difference between removing a connection and requesting erasure of stored information. No response deadline or outcome is promised by this page.</p>
    </section>`;
    case "/privacy": return html`<p class="lead">How ${brand.name} processes information when you use this instance.</p>
    <section>
      <h2>Operator and purposes</h2>
      <p>The operator of this instance is responsible for the workspace data processed here. Contact the operator for questions about access, correction, deletion or the applicable legal basis for your use of the service.</p>${contact}
      <p>The application stores login details, workspace membership, connected account identifiers, encrypted authorisation credentials, uploaded media, captions, schedules and delivery results to provide the actions you request. For supported messaging connections it also processes conversations, contacts and reply automation records.</p>
    </section>${integrations}
    <section>
      <h2>Sharing and browser storage</h2>
      <p>Media, captions and publishing choices are transmitted to the destination you select when you request publication or a draft upload. Supported conversation actions send replies to the connected service. Those platforms process received data under their own policies. Review the authorisation screen before granting access.</p>
      <p>This public module does not load analytics or marketing trackers. The application uses a session cookie for sign-in and a theme preference to remember its appearance. The instance can also send aggregate usage telemetry if enabled by its operator; this excludes message content, contacts and social authorisation credentials. Ask the operator about its configuration and any infrastructure logs.</p>
    </section>${retention}
    <section>
      <h2>Control and requests</h2>
      <p>Disconnect an account to stop its local connection and revoke access separately on the platform. Existing records and published posts are not erased by disconnecting. Use the Data deletion page for stored-data requests and contact the operator about backups. You may also raise a privacy concern with the relevant data protection authority.</p>
    </section>`;
    case "/terms": return html`<p class="lead">Conditions for using the ${brand.name} instance at ${brand.publicUrl}.</p>
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
    <section>
      <h2>Ending use and questions</h2>
      <p>Disconnect channels to stop their local connections. Request account or workspace data deletion through the operator; published posts must be managed on their destination platforms separately. Privacy describes the information processed here, and Data deletion explains the available steps.</p>${contact}
    </section>`;
    case "/data-deletion": return html`<p class="lead">Choose the action that matches what you want removed from ${brand.name}.</p>${deletion}${retention}`;
  }
}
