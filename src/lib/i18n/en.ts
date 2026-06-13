// English catalog (the default locale). Keys are dotted, namespaced by surface. Values may
// reference `{var}` placeholders; `{brand}` is always available (injected by t()). Adding a
// locale = a sibling file with the same keys, registered in index.ts. Keep keys stable —
// they are the contract the UI calls through.
export const en = {
  // Page titles — "{section} · {brand}" composes the document <title>.
  "title.suffix": "{section} · {brand}",
  "title.signIn": "Sign in · {brand}",
  "title.register": "Register · {brand}",

  // API docs
  "apiDocs.title": "{brand} API Docs",
} as const;

export type MessageKey = keyof typeof en;
