import { cookies } from "next/headers";

import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries";

export type Locale = keyof typeof dictionaries;

export const LOCALE_COOKIE = "hf_locale";
export const defaultLocale: Locale = "no";
export const locales = Object.keys(dictionaries) as Locale[];

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (locales as string[]).includes(value);
}

/** Reads the visitor's locale from the cookie set by the language switcher. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : defaultLocale;
}

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Convenience for server components that only need the strings. */
export async function getTranslations(): Promise<Dictionary> {
  return getDictionary(await getLocale());
}

export type { Dictionary };
