// Minimal, dependency-free i18n. `t(key, vars)` looks the key up in the active locale's catalog
// and interpolates `{var}` placeholders. `{brand}` is always injected from BRAND so brand-bearing
// copy needs no per-call wiring. Default locale: en. A second locale (e.g. pl) registers in
// `catalogs` with the same keys — the MessageKey type keeps catalogs in sync at compile time.
import { BRAND } from "@/lib/brand";
import { en, type MessageKey } from "./en";

export type Locale = "en";

const catalogs: Record<Locale, Record<MessageKey, string>> = { en };

let locale: Locale = "en";

/** Override the active locale (e.g. from a request header later). KISS: process-global for now. */
export function setLocale(next: Locale): void {
  locale = next;
}

export function t(key: MessageKey, vars: Record<string, string> = {}): string {
  const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  const all: Record<string, string> = { brand: BRAND.name, ...vars };
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in all ? all[name] : `{${name}}`,
  );
}
