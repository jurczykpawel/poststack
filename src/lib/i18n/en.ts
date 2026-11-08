// English catalog (the default locale). Keys are dotted, namespaced by surface. Values may
// reference `{var}` placeholders; `{brand}` is always available (injected by t()). Adding a
// locale = a sibling file with the same keys, registered in index.ts. Keep keys stable —
// they are the contract the UI calls through.
export const en = {
  // Page titles — "{section} · {brand}" composes the document <title>.
  "title.suffix": "{section} · {brand}",
  "title.signIn": "Sign in · {brand}",
  "title.register": "Register · {brand}",

  // Insights (/insights and the channel detail panel). Mirrors the accepted mockup copy.
  "insights.title": "Insights",
  "insights.intro": "Account statistics collected from the platform. One channel at a time.",
  "insights.locked": "Account Insights are a PRO feature. Collected numbers stay on your instance.",
  "insights.noChannels.title": "Connect a channel that provides Insights",
  "insights.noChannels.body": "Account statistics are available for professional accounts on: {platforms}.",
  "insights.missing.title": "This channel is not available",
  "insights.missing.body": "It is not connected to this workspace. Pick a channel from the list above.",
  "insights.off.title": "Turn on Insights for {channel}",
  "insights.off.body": "{brand} will collect these account metrics once a day: {metrics}.",
  "insights.off.note": "The platform may ask for one additional permission. Publishing and Inbox keep working unchanged. History builds up over time, because the platform only shares recent days.",
  "insights.off.retained": "Collection is off. Previously collected data is shown below.",
  "insights.checking.title": "Collecting the first data",
  "insights.checking.body": "This usually takes a few minutes. The platform only shares recent history, so a full 30 days fills in over time.",
  "insights.permission.title": "Insights needs additional access",
  "insights.permission.body": "The login used for this channel does not include the statistics permission. Publishing and Inbox keep working.",
  "insights.permission.declined": "If you declined the permission, grant it again. The data you already collected stays.",
  "insights.reauth.title": "Sign in again to keep collecting",
  "insights.reauth.body": "The login used for Insights is no longer valid. Publishing and Inbox use their own status on the Channels page.",
  "insights.unsupported.title": "This account does not provide account statistics",
  "insights.unsupported.body": "The platform shares account statistics only for professional (business or creator) accounts.",
  "insights.paused.title": "Channel is paused",
  "insights.paused.body": "Collection resumes when the channel is active again.",
  "insights.limited.title": "Showing data collected {at}",
  "insights.limited.body": "The platform is temporarily limiting requests. Next attempt: {next}.",
  "insights.unavailable.body": "The platform did not answer the last request. Next attempt: {next}.",
  "insights.delayed.title": "Collection looks delayed",
  "insights.delayed.body": "No new data has arrived for a while. Check that the worker process is running.",
  "insights.empty.title": "No data for this period yet",
  "insights.empty.body": "Data appears after the next collection. The platform can deliver it up to 48 hours late.",
  "insights.sync.never": "Not synced yet",
  "insights.sync.provisional": "The platform can update data for 48 hours; the last 2 days are provisional (dashed line).",
  "insights.refresh.queued": "Refresh queued. Checking for new data…",
  "insights.refresh.later": "Next refresh available {at}.",
  "insights.refresh.done": "New data collected.",
  "insights.refresh.waiting": "Still collecting. New data appears here after the worker finishes; reload the page later.",
  "insights.uniqueTotal": "Total not available for unique metrics",
  "insights.noComparison": "No comparison: incomplete data",
  "insights.incomplete": "Incomplete data for this period",
  "insights.inactive": "Not collected for this channel yet: {metrics}.",

  // API docs
  "apiDocs.title": "{brand} API Docs",
} as const;

export type MessageKey = keyof typeof en;
