import { useSyncExternalStore } from "react";
import { readPref, writePref } from "../lib/prefs";
import { en } from "./en";
import { ptPT } from "./pt-PT";

/**
 * Translations. English is the source: a key missing from another language falls back to it, and a key
 * missing from English is a type error. Placeholders are `{name}`; a key with `_one` and `_other` variants
 * is a plural chosen by the `count` value (`t("files", { count: 3 })` reads `files_other`).
 */

export type Locale = "en" | "pt-PT";
export type LanguagePref = "system" | Locale;

export const LANGUAGES: { id: LanguagePref; label: string }[] = [
  { id: "system", label: "" }, // "Follow system" is translated where it is shown
  { id: "en", label: "English" },
  { id: "pt-PT", label: "Português (Portugal)" },
];

type Catalog = Partial<Record<keyof typeof en, string>>;
const CATALOGS: Record<Locale, Catalog> = { en, "pt-PT": ptPT };

type Plural<K extends string> = K extends `${infer B}_one` | `${infer B}_other` ? B : K;
export type Key = Plural<keyof typeof en & string>;

const PREF = "language";

/** The language the system asks for, when it is one we have. */
export function systemLocale(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? []): Locale {
  for (const l of languages) {
    if (/^pt\b/i.test(l)) return "pt-PT";
    if (/^en\b/i.test(l)) return "en";
  }
  return "en";
}

export function resolveLocale(pref: LanguagePref, system: Locale = systemLocale()): Locale {
  return pref === "system" ? system : pref;
}

function storedPref(): LanguagePref {
  const v = readPref<string>(PREF, "system");
  return v === "en" || v === "pt-PT" ? v : "system";
}

let pref: LanguagePref = storedPref();
let locale: Locale = resolveLocale(pref);
let version = 0;
const listeners = new Set<() => void>();

function announce() {
  version++;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  listeners.forEach((l) => l());
}

export function setLanguage(next: LanguagePref) {
  pref = next;
  locale = resolveLocale(next);
  writePref(PREF, next);
  announce();
}

export const getLanguagePref = () => pref;
export const getLocale = () => locale;

/** Looks a message up in `lang`, falling back to English, then to the key itself (so a gap shows up as text, not as a crash). */
export function translate(lang: Locale, key: string, vars?: Record<string, string | number>): string {
  const catalog = CATALOGS[lang] as Record<string, string | undefined>;
  let k = key;
  if (vars && typeof vars.count === "number") {
    const rule = new Intl.PluralRules(lang).select(vars.count);
    const plural = `${key}_${rule === "one" ? "one" : "other"}`;
    if (catalog[plural] !== undefined || (en as Record<string, string>)[plural] !== undefined) k = plural;
  }
  const text = catalog[k] ?? (en as Record<string, string>)[k] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text;
}

export type TFunction = (key: Key, vars?: Record<string, string | number>) => string;

/** For code that is not a component (messages written when something happens). Components use `useT`, which also re-renders them on a language change. */
export const t: TFunction = (key, vars) => translate(locale, key, vars);

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useT(): TFunction {
  useSyncExternalStore(subscribe, () => version);
  return t;
}

export function useLanguage(): [LanguagePref, (p: LanguagePref) => void] {
  useSyncExternalStore(subscribe, () => version);
  return [pref, setLanguage];
}

if (typeof document !== "undefined") document.documentElement.lang = locale;

/** Test hooks: every catalog, so a test can compare them. */
export const catalogs = CATALOGS;
