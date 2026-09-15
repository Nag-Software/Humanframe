"use client";

import { useEffect } from "react";

import type { Locale } from "@/lib/i18n/dictionaries";

/** Next.js does not always patch `<html lang>` on a refresh; keep it in sync. */
export function HtmlLang({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return null;
}
