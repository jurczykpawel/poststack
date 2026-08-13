/**
 * Central API-key permission catalog.
 *
 * Validation, enforcement types, OpenAPI and the dashboard all derive from this module. A new
 * permission therefore needs one catalog entry and automatically appears in the correct UI group.
 */
export const API_SCOPE_GROUPS = [
  { id: "connections", label: "Connections", description: "Connected channels and account sources." },
  { id: "inbox", label: "Inbox & CRM", description: "Conversations, contacts and audience tags." },
  { id: "automation", label: "Automation", description: "Rules, sequences and webhook integrations." },
  { id: "publishing", label: "Publishing", description: "Content, posts, brands and media uploads." },
  { id: "workspace", label: "Workspace", description: "Workspace settings and analytics." },
] as const;

export type ApiScopeGroup = (typeof API_SCOPE_GROUPS)[number]["id"];
type ApiScopeAccess = "read" | "write";
type TargetedPreset = "publishing" | "inbox_automation";

type ScopeDefinition = {
  scope: string;
  group: ApiScopeGroup;
  access: ApiScopeAccess;
  label: string;
  presets: readonly TargetedPreset[];
};

export const API_SCOPE_DEFINITIONS = [
  { scope: "channels:read", group: "connections", access: "read", label: "View channels", presets: ["publishing", "inbox_automation"] },
  { scope: "channels:write", group: "connections", access: "write", label: "Manage channels", presets: [] },
  { scope: "conversations:read", group: "inbox", access: "read", label: "View conversations", presets: ["inbox_automation"] },
  { scope: "conversations:write", group: "inbox", access: "write", label: "Reply to conversations", presets: ["inbox_automation"] },
  { scope: "contacts:read", group: "inbox", access: "read", label: "View contacts", presets: ["inbox_automation"] },
  { scope: "contacts:write", group: "inbox", access: "write", label: "Manage contacts", presets: ["inbox_automation"] },
  { scope: "rules:read", group: "automation", access: "read", label: "View rules", presets: ["inbox_automation"] },
  { scope: "rules:write", group: "automation", access: "write", label: "Manage rules", presets: ["inbox_automation"] },
  { scope: "sequences:read", group: "automation", access: "read", label: "View sequences", presets: ["inbox_automation"] },
  { scope: "sequences:write", group: "automation", access: "write", label: "Manage sequences", presets: ["inbox_automation"] },
  { scope: "tags:read", group: "inbox", access: "read", label: "View tags", presets: ["inbox_automation"] },
  { scope: "tags:write", group: "inbox", access: "write", label: "Manage tags", presets: ["inbox_automation"] },
  { scope: "settings:read", group: "workspace", access: "read", label: "View settings", presets: [] },
  { scope: "settings:write", group: "workspace", access: "write", label: "Manage settings", presets: [] },
  { scope: "sources:read", group: "connections", access: "read", label: "View account sources", presets: [] },
  { scope: "sources:write", group: "connections", access: "write", label: "Manage account sources", presets: [] },
  { scope: "webhooks:read", group: "automation", access: "read", label: "View webhooks", presets: ["inbox_automation"] },
  { scope: "webhooks:write", group: "automation", access: "write", label: "Manage webhooks", presets: ["inbox_automation"] },
  { scope: "stats:read", group: "workspace", access: "read", label: "View analytics", presets: [] },
  { scope: "content:read", group: "publishing", access: "read", label: "View content", presets: ["publishing"] },
  { scope: "content:write", group: "publishing", access: "write", label: "Manage content", presets: ["publishing"] },
  { scope: "posts:read", group: "publishing", access: "read", label: "View posts", presets: ["publishing"] },
  { scope: "posts:write", group: "publishing", access: "write", label: "Publish and manage posts", presets: ["publishing"] },
  { scope: "brands:read", group: "publishing", access: "read", label: "View brands", presets: ["publishing"] },
  { scope: "brands:write", group: "publishing", access: "write", label: "Manage brands", presets: [] },
  { scope: "media:write", group: "publishing", access: "write", label: "Upload media", presets: ["publishing"] },
] as const satisfies readonly ScopeDefinition[];

export type ApiScope = (typeof API_SCOPE_DEFINITIONS)[number]["scope"];

export const API_SCOPES: readonly ApiScope[] = Object.freeze(
  API_SCOPE_DEFINITIONS.map(({ scope }) => scope),
);

function buildPreset<const Id extends string>(
  id: Id,
  label: string,
  description: string,
  matches: (definition: (typeof API_SCOPE_DEFINITIONS)[number]) => boolean,
) {
  return Object.freeze({
    id,
    label,
    description,
    scopes: Object.freeze(API_SCOPE_DEFINITIONS.filter(matches).map(({ scope }) => scope)),
  });
}

function belongsToPreset(
  definition: (typeof API_SCOPE_DEFINITIONS)[number],
  preset: TargetedPreset,
): boolean {
  return (definition.presets as readonly TargetedPreset[]).includes(preset);
}

/** Presets replace the current selection; users can still refine individual checkboxes afterwards. */
export const API_SCOPE_PRESETS = Object.freeze([
  buildPreset("read_only", "Read only", "Inspect data without making changes.", ({ access }) => access === "read"),
  buildPreset("publishing", "Publishing", "Create, schedule and inspect content and posts.", (definition) => belongsToPreset(definition, "publishing")),
  buildPreset("inbox_automation", "Inbox & automation", "Work with conversations, contacts and automations.", (definition) => belongsToPreset(definition, "inbox_automation")),
]);
