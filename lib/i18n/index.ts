import { cookies, headers } from "next/headers";

import {
  dictionaries,
  isLocale,
  defaultLocale,
  LOCALE_COOKIE,
  type Dictionary,
  type Locale,
} from "@/lib/i18n/dictionaries";

export {
  dictionaries,
  isLocale,
  defaultLocale,
  locales,
  LOCALE_COOKIE,
  formatMessage,
  intlLocales,
} from "@/lib/i18n/dictionaries";

export type { Dictionary, Locale };

function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) {
    return defaultLocale;
  }

  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qualityParam = params.find((param) => param.trim().startsWith("q="));
      const quality = qualityParam ? Number(qualityParam.trim().slice(2)) : 1;
      return {
        tag: (tag ?? "").trim().toLowerCase(),
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .sort((left, right) => right.quality - left.quality);

  for (const { tag } of candidates) {
    if (
      tag === "nb" ||
      tag === "nn" ||
      tag === "no" ||
      tag.startsWith("nb-") ||
      tag.startsWith("nn-") ||
      tag.startsWith("no-")
    ) {
      return "no";
    }
    if (tag === "en" || tag.startsWith("en-")) {
      return "en";
    }
  }

  return defaultLocale;
}

/** Reads the visitor's locale from the cookie set by the language switcher. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(value)) {
    return value;
  }
  return localeFromAcceptLanguage((await headers()).get("accept-language"));
}

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Convenience for server components that only need the strings. */
export async function getTranslations(): Promise<Dictionary> {
  return getDictionary(await getLocale());
}
