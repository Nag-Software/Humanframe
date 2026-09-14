"use client";

import { createContext, useContext, type ReactNode } from "react";

import { en, type Dictionary } from "@/lib/i18n/dictionaries";

const I18nContext = createContext<Dictionary>(en);

export function I18nProvider({
  dictionary,
  children,
}: {
  dictionary: Dictionary;
  children: ReactNode;
}) {
  return (
    <I18nContext.Provider value={dictionary}>{children}</I18nContext.Provider>
  );
}

/** Client-side access to the same dictionary the server rendered with. */
export function useTranslations(): Dictionary {
  return useContext(I18nContext);
}
