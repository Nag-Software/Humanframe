import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

import { HtmlLang } from "@/components/html-lang";
import { I18nProvider } from "@/components/i18n-provider";
import { getDictionary, getLocale, getTranslations } from "@/lib/i18n";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The editorial voice of the brand: titles, big numbers, the wordmark.
const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return {
    title: {
      default: "Humanframe",
      template: "%s · Humanframe",
    },
    description: t.meta.description,
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const dictionary = getDictionary(locale);

  return (
    <html
      lang={locale}
      className={`${geist.variable} ${geistMono.variable} ${instrument.variable} h-full antialiased`}
    >
      <body>
        <HtmlLang locale={locale} />
        <I18nProvider locale={locale} dictionary={dictionary}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
