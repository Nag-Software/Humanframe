import type { Metadata } from "next";

import { PageSkeleton } from "@/components/page-skeleton";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.settings.pages.billing.metaTitle };
}

export default async function SettingsBillingPage() {
  const t = await getTranslations();
  const copy = t.settings.pages.billing;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{copy.title}</h2>
        <p className="text-muted-foreground text-sm">{copy.description}</p>
      </div>
      <PageSkeleton variant="list" rows={3} />
    </section>
  );
}
