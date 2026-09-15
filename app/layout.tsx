import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import { HtmlLang } from "@/components/html-lang";
import { I18nProvider } from "@/components/i18n-provider";
import { getDictionary, getLocale, getTranslations } from "@/lib/i18n";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
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
      className={`${spaceGrotesk.variable} ${inter.variable} h-full antialiased`}
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
