"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import { en, type Dictionary, type Locale } from "@/lib/i18n/dictionaries";

type I18nContextValue = {
  locale: Locale;
  dictionary: Dictionary;
};

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  dictionary: en,
});

export function I18nProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, dictionary }),
    [locale, dictionary]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Client-side access to the same dictionary the server rendered with. */
export function useTranslations(): Dictionary {
  return useContext(I18nContext).dictionary;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
