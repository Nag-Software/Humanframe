import type { Metadata } from "next";

import { LanguageSwitcher } from "@/components/language-switcher";
import { PageSkeleton } from "@/components/page-skeleton";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.settings.pages.general.metaTitle };
}

export default async function SettingsGeneralPage() {
  const t = await getTranslations();
  const copy = t.settings.pages.general;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{copy.title}</h2>
        <p className="text-muted-foreground text-sm">{copy.description}</p>
      </div>
      <LanguageSwitcher />
      <PageSkeleton variant="form" rows={3} />
    </section>
  );
}
