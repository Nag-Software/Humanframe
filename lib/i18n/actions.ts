"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import {
  isLocale,
  LOCALE_COOKIE,
  type Locale,
} from "@/lib/i18n/dictionaries";

export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) {
    return;
  }

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}

export async function setLocaleFromForm(formData: FormData): Promise<void> {
  const locale = String(formData.get("locale") ?? "");
  if (isLocale(locale)) {
    await setLocale(locale);
  }
}
